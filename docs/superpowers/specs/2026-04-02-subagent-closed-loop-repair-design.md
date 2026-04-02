# Subagent 会话聚合与闭环路由设计

日期：2026-04-02

## 功能概述

本特性的目标是让 `message-bridge` 正式支持 OpenCode subagent 会话，并与 `opencode-cui release-0401` 形成一致协议：

1. 上游事件按父会话聚合展示
2. 事件仍保留真实 subagent 身份
3. 用户对 subagent 产生的交互进行回复时，消息能准确回到对应子会话

换句话说，本特性要解决的是：

- **展示层面**：主会话中能看见“这是哪个 subagent 发出的事件”
- **路由层面**：中间层可以把针对 subagent 的回复准确送回原始 child session
- **协议层面**：插件、中间层、Miniapp 对 `toolSessionId / subagentSessionId / subagentName` 的含义一致

## 用户可见结果

特性完成后，外部观察到的行为应为：

1. 对于 subagent 产生的上行事件，gateway / skill 侧看到的是父会话主线，而不是把每个 child session 当成独立主会话。
2. 同一条事件会携带 subagent 身份信息，供 skill-server / miniapp 展示“来自哪个 subagent”。
3. 当用户对 subagent 的 question / permission 进行回复时，该回复不会误打到父 session，而会准确回到 child session。
4. 对于普通非 subagent 会话，协议和行为与当前一致。

## 目标

本设计限定以下目标：

1. 在插件上行协议中稳定产出：
   - 父会话路由键
   - 子会话标识
   - 子 agent 展示名
2. 明确插件与 `release-0401` 的协议分工
3. 使下游回复形成闭环，但不在插件内引入猜测式路由
4. 以测试形式固化该契约

## 非目标

本次不做：

- 在插件中新增一个独立的下行 `subagentSessionId` 解析分支
- 在插件内推断“父会话下当前活跃的 child session 是谁”
- 在下游未提供真实 child session id 时，由插件自行猜测目标子会话
- 重写原始 event payload 内部的 session 字段

## 协议语义

### 上行语义

插件发送 `tool_event` 时，字段语义固定为：

- `toolSessionId`
  - 表示**父会话 id**
  - 是 gateway / skill 侧聚合主会话的主路由键
- `subagentSessionId`
  - 表示**真实 child session id**
  - 用于展示 subagent 来源，以及为后续回复提供定位依据
- `subagentName`
  - 表示 child agent 的展示名

对普通主会话事件：

- `toolSessionId` 仍为该主会话本身
- `subagentSessionId/subagentName` 不出现

### 下行语义

插件下行继续只认现有协议：

- `invoke.payload.toolSessionId`

若目标是 subagent，中间层必须在下行请求中把 **child session id** 写入 `payload.toolSessionId`。

因此，本特性的闭环语义不是“插件解析一个新的下行 subagent 字段”，而是：

1. 插件上行稳定提供 `subagentSessionId`
2. 中间层保留该字段
3. 中间层在真正回发插件前，把 child session id 写回现有下行 `payload.toolSessionId`

这与 `release-0401` 的现有语义保持一致。

## 系统边界

### 插件负责什么

`message-bridge` 负责：

1. 识别某个 session 是否为 subagent child session
2. 把 child session 的上行事件聚合到父 session
3. 附带真实 `subagentSessionId/subagentName`
4. 对 child `session.idle` 采取与主会话不同的完成态处理，避免误发 `tool_done`

### 中间层负责什么

`release-0401` 范围内的 gateway / skill-server / miniapp 负责：

1. 保留 `subagentSessionId/subagentName`
2. 在用户回复 `permission_reply/question_reply` 时，把目标 child session id 写回 `payload.toolSessionId`

### 插件不负责什么

插件不负责：

1. 从父会话上下文猜测应该回复给哪个 child session
2. 在下游没有回填 child id 时做歧义决策

## 核心设计

### 1. Child Session 识别

插件内部维护 `childSessionId -> parentSessionId` 映射。

映射来源分两类：

1. **主动缓存**
   - 收到 `session.created`
   - 若包含 `parentID`
   - 立即写入 child 映射

2. **兜底查询**
   - 若普通事件到达时缓存未命中
   - 使用 `session.get(sessionID)` 查询该 session 元信息
   - 查询结果按当前 `@opencode-ai/plugin` / SDK 接口契约解析
   - 若结果包含 `parentID`，补写映射

同时，主会话也要写入负缓存，避免普通主会话首个事件反复触发兜底查询。

`session.created` 在本特性中被定义为**插件内部控制事件**：

- 插件必须处理它，用于维护 parent-child 映射
- 插件永远不向 gateway 转发它
- 它不受业务上游转发 allowlist 影响

这样可以避免用户显式配置 allowlist 时，因为遗漏 `session.created` 而导致 subagent 映射预热失效。

### 2. Event 聚合投影

当事件来自 child session 时：

1. 外层 `toolSessionId` 改写为父 session id
2. 外层附加：
   - `subagentSessionId = childSessionId`
   - `subagentName = agentName`
3. 原始 event payload 保持原始来源，不做深层字段重写

这样做的原因是：

- 外层 envelope 是跨系统路由和聚合键
- 内层 raw event 是 OpenCode 原始事实

本特性选择明确区分这两层语义，而不是强行让两者看起来完全一致。

### 3. Idle / Done 行为

对 child session 的 `session.idle`，插件不进入主会话的 `ToolDoneCompat` 逻辑。

原因：

- child session 的 idle 仅表示 subagent 自己的局部完成
- 若直接沿用主会话 `tool_done` 兼容逻辑，会误把父主线视为完成

对主会话保持现有行为不变。

### 4. Downstream 闭环

插件侧下行动作不新增特殊分支，继续按 `payload.toolSessionId` 路由。

当前特性只对齐 `release-0401` 已明确支持的闭环动作：

- `permission_reply`
- `question_reply`

对插件来说保持同一规则：

- 收到哪个 `payload.toolSessionId`
- 就路由到哪个真实 OpenCode session

这要求中间层在面向 subagent 时，必须把 child session id 填回该字段。

对于以下动作：

- `chat`
- `abort_session`
- `close_session`

本次特性不承诺 subagent 精确回路由能力。若后续需要支持，应在中间层协议和交互语义明确后单独扩展，不在本次范围内一并定义。

## 数据流

### 上行

1. OpenCode 发出 child session 事件
2. 插件识别其 parent-child 关系
3. 插件发送：
   - `toolSessionId = parent`
   - `subagentSessionId = child`
   - `subagentName = ...`
4. Gateway / skill / miniapp 按父会话聚合展示，并保留 subagent 身份

### 下行

1. 用户在 UI 中对某个 subagent 事件进行回复
2. 中间层根据保存的 `subagentSessionId` 确定真实 child session
3. 中间层向插件发送 `invoke`
4. `invoke.payload.toolSessionId = child`
5. 插件按现有逻辑把 `permission_reply/question_reply` 路由到对应 child session

## 兼容性与约束

### 普通主会话兼容性

普通非 subagent 会话：

- 不出现 `subagentSessionId/subagentName`
- `toolSessionId` 与当前一致
- 下行动作行为不变

### 调用方契约约束

如果下游没有把 child session id 写回 `payload.toolSessionId`，插件不会报错地“恢复正确 child”，而会按收到的 session id 正常执行。

这是明确的协议边界，不属于插件内部恢复逻辑。

## 测试设计

### 单元测试

1. `upstream-event-extractor`
   - `session.created` 成为受支持控制事件
   - 校验合法 `session.created` 可抽取
   - 校验字段缺失时返回明确错误
   - 校验 `session.created` 作为控制事件不受业务转发 allowlist 约束

2. `SubagentSessionMapper`
   - child `session.created` 建立映射
   - 主会话 `session.created` 建立负缓存
   - `resolve()` 按当前 `@opencode-ai/plugin` 接口契约解析 `session.get`
   - 缓存命中时不重复查询

3. `runtime-protocol`
   - child 事件上行后外层 `toolSessionId` 被改写为父 session
   - child 事件附带 `subagentSessionId/subagentName`
   - child `session.idle` 不触发 `tool_done`
   - `session.created` 在显式 allowlist 未包含时仍能建缓存且不转发
   - 主会话事件保持现有行为

### 集成测试

增加一组最小闭环测试：

1. child `permission/question` 事件进入插件后，上行结果包含 `subagentSessionId`
2. 模拟中间层把 child id 写回 `payload.toolSessionId`
3. `permission_reply/question_reply` 命中正确 child session

插件侧不测试 Miniapp 的视觉展示，只测试协议和路由闭环。

## 验证标准

必须满足：

1. `pnpm --filter @wecode/skill-opencode-plugin typecheck` 通过
2. `@wecode/skill-opencode-plugin` 受影响单测通过
3. 至少一组 subagent 闭环集成测试通过
4. PR 描述明确说明：
   - 上行 `toolSessionId` 的父会话语义
   - `subagentSessionId` 的定位语义
   - 插件下行仍只消费 `payload.toolSessionId`
   - 当前闭环动作范围仅包含 `permission_reply/question_reply`

## 当前实现差距

为了实现上述特性，当前分支需要补齐以下差距：

1. `session.get()` 兜底逻辑需严格按当前 `@opencode-ai/plugin` 接口契约实现，不再兼容平铺 fallback
2. `session.created` 需升级为不受业务 allowlist 影响的控制事件，并同步更新测试与契约
3. 主会话需加入负缓存，降低热路径查询
4. 需要新增覆盖 subagent 聚合与 `permission_reply/question_reply` 闭环路由的测试

这些差距属于该特性的实现收尾工作，而不是另一个独立功能。

## 风险

### 风险 1：中间层未正确回填 child id

结果：
回复会落到父 session，而不是 child session。

控制方式：
- 在测试中把契约固定下来
- 在 PR 描述中明确边界

### 风险 2：外层与内层 session 语义不同

结果：
消费方如果错误读取 raw event 内部 session 字段，可能与 envelope 产生理解偏差。

控制方式：
- 把“外层用于路由聚合，内层保留原始来源”写成明确契约
- 本次不引入更复杂的 raw event 重写逻辑

### 风险 3：首次事件查询带来抖动

结果：
缓存 miss 时增加一次 `session.get()`

控制方式：
- child 通过 `session.created` 主动建缓存
- 主会话写入负缓存

## 实现任务骨架

1. 修正 `SubagentSessionMapper` 的兜底解析与负缓存
2. 固化 `session.created` 的控制事件契约，并提前于业务转发 allowlist 处理
3. 完成 child 事件聚合与 idle 行为测试
4. 补 `permission_reply/question_reply` 的最小闭环集成测试
5. 更新 PR 描述，使协议语义、动作范围与测试一致

## 结论

本特性不是“为当前 PR 打补丁”，而是为 `message-bridge` 正式定义 subagent 会话协议：

- 上行按父会话聚合
- 同时保留真实 subagent 身份
- 下行继续沿用既有 `payload.toolSessionId`，由中间层回填 child id 实现 `permission_reply/question_reply` 闭环

这是与 `release-0401` 最一致、最可验证、也最小化额外复杂度的方案。
