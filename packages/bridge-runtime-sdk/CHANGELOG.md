# Changelog

本文记录 `@wecode/bridge-runtime-sdk` 的重要变更。

## Unreleased

### Breaking Changes

- `RuntimeOutboundEmitter.emitOutboundRun(input)` 改为必填方法；所有第三方 provider 和测试 mock 都需要实现该方法。

### Public API

- `RuntimeOutboundEmitter` 新增方法 `emitOutboundRun(input)`，用于发送带 `runId` 的主动 facts 流。
- 新增 `EmitOutboundRunInput` 类型，字段包含 `toolSessionId`、`runId`、`trigger`、`facts`。
- `RuntimeOutboundEmitter.emitOutboundMessage(input)` 标记为废弃；新接入应使用 `emitOutboundRun(input)`。
