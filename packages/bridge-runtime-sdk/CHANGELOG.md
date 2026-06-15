# Changelog

本文记录 `@wecode/bridge-runtime-sdk` 的重要变更。

## Unreleased

### Public API

- `RuntimeOutboundEmitter` 新增必填方法 `emitOutboundRun(input)`，用于发送带 `runId` 的主动 facts 流。
- 新增 `EmitOutboundRunInput` 类型，字段包含 `toolSessionId`、`runId`、`trigger`、`facts`。
- `RuntimeOutboundEmitter.emitOutboundMessage(input)` 标记为废弃；新接入应使用 `emitOutboundRun(input)`。
