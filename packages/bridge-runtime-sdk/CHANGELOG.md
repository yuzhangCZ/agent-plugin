# Changelog

本文记录 `@wecode/bridge-runtime-sdk` 的重要变更。

## Unreleased

### Breaking Changes

- `RuntimeOutboundEmitter.emitOutboundRun(input)` 改为必填方法；所有第三方 provider 和测试 mock 都需要实现该方法。
- `ToolUpdateFact.input` 从 `string` 改为 `Record<string, unknown>`；provider 需要传入 JSON 对象，SDK 会拒绝字符串、数组、`null`、数字和布尔值。

### Public API

- `RuntimeOutboundEmitter` 新增方法 `emitOutboundRun(input)`，用于发送带 `runId` 的主动 facts 流。
- 新增 `EmitOutboundRunInput` 类型，字段包含 `toolSessionId`、`runId`、`trigger`、`facts`。
- `RuntimeOutboundEmitter.emitOutboundMessage(input)` 标记为废弃；新接入应使用 `emitOutboundRun(input)`。
- `ToolUpdateFact.input` 与 cloud `tool.update.properties.input` 统一为 JSON 对象，适配 opencode `ToolPart.state.input` 和下游 Skill SDK 对象消费模型。
