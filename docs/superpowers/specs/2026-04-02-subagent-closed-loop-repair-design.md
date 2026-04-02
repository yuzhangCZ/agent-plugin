# Subagent 闭环修复设计

日期：2026-04-02

## 背景

`plugins/message-bridge` 的 PR 53 试图把 OpenCode subagent 事件按父 session 聚合转发给 gateway：

- 上行事件外层 `toolSessionId` 被改写为父 session id
- 同时附带 `subagentSessionId` 和 `subagentName`

该方向本身正确，但当前实现还不能形成稳定闭环，主要问题有：

1. `session.get()` 兜底解析错误，缓存 miss 时无法可靠识别 child session。
2. `session.created` 被纳入支持事件后，相关测试和契约未同步更新。
3. 插件侧没有明确写清“下行闭环依赖什么协议语义”，导致容易误判为还需要插件额外解析下行 `subagentSessionId`。
4. 普通 session 未做负缓存，首个事件会多一次不必要的 `session.get()` 查询。

同时，`integration/opencode-cui` 的 `release-0401` 已经引入并消费了：

- `subagentSessionId`
- `subagentName`

并在 Skill Server / Miniapp 链路中把 `subagentSessionId` 用于回写真实目标 `payload.toolSessionId`。因此插件侧应直接对齐该语义，而不是另起一套双向映射协议。

## 目标

本次修复只采用“对齐 `release-0401` 的最小闭环方案”：

1. 插件上行继续使用：
   - `toolSessionId` = 父 session id
   - `subagentSessionId` = 子 session id
   - `subagentName` = 子 agent 展示名
2. 插件下行继续只消费 `payload.toolSessionId`
3. 中间层若要命中 subagent，必须在下行请求中把 child session id 写回 `payload.toolSessionId`
4. 补齐测试和契约，使该语义在代码中可验证、可回归

## 不做的事

本次不做以下扩展：

- 不在插件中引入新的下行 `subagentSessionId` 解析分支
- 不在插件内维护 `parent -> child` 的交互态推断映射
- 不尝试在下游未回填 child session id 时，由插件猜测目标 subagent

原因是这些能力会引入歧义，尤其在多个 subagent 并发时不可可靠验证。

## 选定方案

### 协议契约

插件与 `release-0401` 对齐后的协议语义如下：

- 上行 `tool_event`
  - `toolSessionId`：父 session id，用于 gateway 和 skill 侧聚合主会话
  - `subagentSessionId`：真实子 session id，用于展示和后续回复定位
  - `subagentName`：展示字段
- 下行 `invoke`
  - 插件只读取 `payload.toolSessionId`
  - 若目标是 subagent，中间层必须把 child session id 写回 `payload.toolSessionId`

这意味着插件侧的“闭环”并不是解析新的下行字段，而是保证上行字段稳定、清晰，并依赖中间层把目标 child id 重新投影回现有下行协议。

### 插件内部职责

`BridgeRuntime` 和 `SubagentSessionMapper` 的职责边界调整为：

- `SubagentSessionMapper`
  - 维护 `childSessionId -> { parentSessionId, agentName }`
  - 支持主 session 负缓存，避免重复 `session.get()`
  - 兜底查询时兼容 `session.get() -> { data: ... }` 返回形态
- `BridgeRuntime`
  - 对 `session.created` 只建映射，不转发
  - 对识别出的 child session 事件改写外层 `toolSessionId`
  - 对 child `session.idle` 不进入 `ToolDoneCompat`
  - 对普通 session 保持现有行为不变

### 兼容性约束

如果下游未把 child session id 回填到 `payload.toolSessionId`，插件不会尝试恢复真实 child session，而是按收到的 session id 继续执行。

这不是插件侧 bug，而是调用方未遵守协议契约。该边界必须写入测试与 PR 描述。

## 详细设计

### 1. Upstream 事件处理

保留 PR 53 的总体结构，但修正细节：

- `session.created`
  - 作为内部控制事件使用
  - 提取 `properties.info.id`
  - 若存在 `parentID`，写入 child 映射缓存
  - 若不存在 `parentID`，写入主 session 负缓存
  - 该事件不转发给 gateway

- 其他事件
  - 先根据当前事件里的 session id 查询映射
  - 若命中 child 映射，则：
    - 外层 `toolSessionId` 改写为 `parentSessionId`
    - 附加 `subagentSessionId`
    - 附加 `subagentName`
  - 若未命中，则保持原始 `toolSessionId`

### 2. `session.get()` 兜底查询

`SubagentSessionMapper.resolve()` 必须兼容仓库现有 SDK 适配语义。

已知仓库其他实现普遍把 `session.get()` 当作：

```ts
{ data: { ...sessionFields } }
```

因此 mapper 解析逻辑必须：

1. 先判断返回值是否为对象
2. 优先读取 `result.data`
3. 若 `result.data` 存在则从其中读取 `parentID/title`
4. 若 `result.data` 不存在，再兼容读取平铺字段

这样可以兼容当前 SDK 适配层，也降低未来协议变更的脆弱性。

### 3. 主 session 负缓存

当前 PR 只缓存 child session，导致普通 session 首个事件会额外触发一次 `session.get()`。

修复后应统一缓存两类结果：

- child session：`Map<sessionId, SubagentMapping>`
- 主 session：`Map<sessionId, null>`

收益：

- 避免热路径不必要查询
- 降低对 SDK 可用性的耦合
- 使事件转发延迟更稳定

### 4. Downstream 动作闭环

插件侧不新增新的解析分支。闭环成立条件为：

- gateway / skill-server / miniapp 在收到上行 `subagentSessionId` 后保留该字段
- 用户对 permission/question 等交互作答时，中间层使用 `subagentSessionId` 作为真实目标 session
- 中间层在发回插件前，把该值写回下行 `payload.toolSessionId`

因此，对插件来说：

- `chat`
- `abort_session`
- `close_session`
- `permission_reply`
- `question_reply`

都继续按现有 `payload.toolSessionId` 路由，不新增插件内的特殊分支。

## 测试设计

### 单元测试

1. `upstream-event-extractor.test`
   - 更新 `session.created` 相关预期
   - 增加合法 `session.created` 抽取用例
   - 增加缺字段时返回 `missing_required_field` 的用例

2. `SubagentSessionMapper` 新增独立单测
   - `session.created` child 写缓存
   - `session.created` 主 session 写负缓存
   - `resolve()` 解析 `{ data: { parentID, title } }`
   - `resolve()` 对主 session 返回 `null` 并缓存
   - `resolve()` 在缓存命中时不重复查询

3. `runtime-protocol.test`
   - child `tool_event` 被重写为父 `toolSessionId`
   - `subagentSessionId/subagentName` 被附加到上行消息
   - child `session.idle` 不触发 `tool_done`
   - 主 session 行为保持原样

### 集成测试

新增一组最小闭环集成测试，覆盖：

1. 上游 child permission/question 事件进入插件后，转发结果中包含 `subagentSessionId`
2. 模拟中间层把 child id 写回下行 `payload.toolSessionId`
3. 插件按该 child id 成功路由 `permission_reply/question_reply`

说明：插件侧不需要直接断言 Miniapp UI 展示，只验证协议闭环和动作命中。

## 验证标准

必须满足：

1. `pnpm --filter @wecode/skill-opencode-plugin typecheck` 通过
2. `@wecode/skill-opencode-plugin` 受影响 unit tests 通过
3. `@wecode/skill-opencode-plugin` 至少一组闭环 integration test 通过
4. PR 描述明确说明：
   - 上行 `toolSessionId` 已重写为父 session id
   - `subagentSessionId` 是下游闭环所依赖的定位字段
   - 插件下行仍只认 `payload.toolSessionId`

## 风险与缓解

### 风险 1：中间层未遵守回填契约

风险：
若 gateway / skill-server 未把 child id 回填到下行 `payload.toolSessionId`，插件会命中父 session。

缓解：
- 在测试中把该契约固定下来
- 在 PR 描述中明确边界
- 与 `release-0401` 对齐验证联调结果

### 风险 2：事件体内 session id 与外层 envelope 不一致

风险：
当前设计只改写外层 `toolSessionId`，原始事件体内部仍保留子 session id。

缓解：
- 本次保持现状，不改 raw event
- 以“外层 envelope 是路由主键，事件体保留原始来源”作为明确契约
- 若后续消费方需要完全一致的投影视图，再单独设计 transport projector 扩展

### 风险 3：热路径额外查询带来延迟抖动

风险：
缓存 miss 时会触发 `session.get()`

缓解：
- 加入主 session 负缓存
- 以 `session.created` 作为主缓存预热路径

## 实现任务骨架

1. 修复 `SubagentSessionMapper` 的 `session.get()` 解析与主 session 负缓存
2. 调整 `session.created` 的契约和测试预期
3. 为 runtime 增加 child 重写与 idle 行为测试
4. 增加最小闭环 integration test
5. 更新 PR 描述中的协议说明与验证证据

## 结论

本方案采用最小且完整的闭环修复策略：

- 插件上行对齐 `release-0401`
- 插件下行不新增分支
- 把闭环责任清晰地拆分为：
  - 插件负责稳定产出 `subagentSessionId`
  - 中间层负责把 child id 写回下行 `payload.toolSessionId`

这样既能修复当前 PR 的功能和测试问题，也能避免在插件内引入不可验证的会话猜测逻辑。
