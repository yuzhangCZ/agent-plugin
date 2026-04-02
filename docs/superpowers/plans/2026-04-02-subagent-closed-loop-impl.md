# Subagent 会话聚合与闭环路由实现计划

日期：2026-04-02

关联规格：
[Subagent 会话聚合与闭环路由设计](/Users/zy/Code/agent-plugin/docs/superpowers/specs/2026-04-02-subagent-closed-loop-repair-design.md)

## 实现目标

按规格完成 `message-bridge` 的 subagent 协议支持，范围限定为：

1. 上行事件按父会话聚合
2. 附带 `subagentSessionId/subagentName`
3. 建立稳定的 child -> parent 映射与主会话负缓存
4. 只闭环 `permission_reply/question_reply`
5. 把 `session.created` 固化为插件内部控制事件，不受业务 allowlist 影响

## 不在本次实现中的内容

- 不扩展 `chat/abort_session/close_session` 的 subagent 精确回路由
- 不在插件下行协议中新增 `subagentSessionId` 解析
- 不修改 `integration/opencode-cui` 内容或 submodule 指针

## 实施顺序

### 阶段 1：收口协议与映射层

目标：先把协议基础打稳，避免后续 runtime 行为建立在错误映射上。

任务：

1. 修正 `SubagentSessionMapper`
   - 兼容 `session.get() -> { data: ... }`
   - 兼容平铺返回形态作为 fallback
   - child session 写正缓存
   - 主会话写负缓存
   - 保留 `clear()` 便于测试

2. 收口 transport/upstream 类型
   - 确保 `tool_event` 类型允许 `subagentSessionId/subagentName`
   - 确保 `session.created` 的 extractor 契约与规格一致

完成标准：

- mapper 单测通过
- extractor 相关单测通过

### 阶段 2：调整 runtime 行为

目标：让事件转发逻辑按规格执行，不扩大现有行为影响面。

任务：

1. 在 `BridgeRuntime.handleEvent()` 中把 `session.created` 提前视为控制事件
   - 不受业务转发 allowlist 影响
   - 仅用于建缓存
   - 永不转发给 gateway

2. 普通事件处理
   - 先解析 normalized event
   - 仅对识别出的 child session 做外层 `toolSessionId` 改写
   - 附带 `subagentSessionId/subagentName`
   - 主会话保持原样

3. `session.idle` 特例
   - child session idle 不进入 `ToolDoneCompat`
   - 主会话仍走现有兼容逻辑

完成标准：

- runtime unit tests 覆盖 child rewrite / idle skip / control-event semantics

### 阶段 3：补齐闭环测试

目标：把“协议成立”变成可回归的自动化验证。

任务：

1. 更新 `upstream-event-extractor.test`
   - 删除旧的 `session.created unsupported` 预期
   - 改为控制事件正向/缺字段测试

2. 新增 `SubagentSessionMapper` 单测文件
   - 主/子 session 缓存
   - `session.get` 两种返回形态
   - 负缓存避免重复查询

3. 扩充 `runtime-protocol.test`
   - `session.created` 在 allowlist 未包含时仍建缓存
   - child 事件外层 `toolSessionId` 改写
   - child idle 不触发 `tool_done`

4. 新增最小闭环 integration test
   - 上游 child permission/question 事件附带 `subagentSessionId`
   - 模拟中间层把 child id 回填到下行 `payload.toolSessionId`
   - `permission_reply/question_reply` 命中 child session

完成标准：

- 受影响 unit/integration 全部通过

### 阶段 4：验证与说明

目标：让实现产物与 PR 叙述一致。

任务：

1. 运行受影响验证命令
2. 整理行为变化与非变化边界
3. 更新 PR 描述：
   - 父会话聚合语义
   - `subagentSessionId` 的定位语义
   - 仅支持 `permission_reply/question_reply` 闭环
   - `session.created` 是插件内部控制事件

## 文件级变更计划

### 预期修改

- `plugins/message-bridge/src/session/SubagentSessionMapper.ts`
- `plugins/message-bridge/src/runtime/BridgeRuntime.ts`
- `plugins/message-bridge/src/contracts/transport-messages.ts`
- `plugins/message-bridge/src/contracts/upstream-events.ts`
- `plugins/message-bridge/src/protocol/upstream/UpstreamEventExtractor.ts`
- `plugins/message-bridge/tests/unit/upstream-event-extractor.test.mjs`
- `plugins/message-bridge/tests/unit/runtime-protocol.test.mjs`
- `plugins/message-bridge/tests/integration/...` 中新增或修改最小闭环用例
- `plugins/message-bridge/tests/unit/` 中新增 mapper 单测

### 不应修改

- `integration/opencode-cui` 源码或 submodule 指针
- `plugins/message-bridge/docs/` 之外的无关文档
- 非 subagent 功能逻辑

## 验证命令

优先按受影响范围执行：

```bash
pnpm --filter @wecode/skill-opencode-plugin typecheck
pnpm --filter @wecode/skill-opencode-plugin test:unit
pnpm --filter @wecode/skill-opencode-plugin test:integration
```

如改动跨运行时边界，补充：

```bash
pnpm verify:workspace
```

## 风险控制

1. 若 runtime 调整导致普通会话转发行为变化，应立即回到“仅 child rewrite”原则收窄变更。
2. 若 integration 测试难以稳定复现完整中间层行为，优先保持插件侧最小闭环模拟，不把外部系统行为硬编码到插件测试中。
3. 若发现 `release-0401` 实际下游行为与规格不一致，停止实现并先回到规格修订，不在代码中私自发明补偿逻辑。

## 完成判定

满足以下条件视为实现计划完成且可进入编码：

1. 文件级改动范围明确
2. 任务顺序与验证方式明确
3. 闭环动作范围明确限定为 `permission_reply/question_reply`
4. `session.created` 与 allowlist 的关系明确
