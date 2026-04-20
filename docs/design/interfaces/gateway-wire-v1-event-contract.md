# gateway-wire-v1 事件契约（历史工作名）

**Version:** 1.1  
**Date:** 2026-04-20  
**Status:** Historical Alias  
**Owner:** agent-plugin maintainers  
**Related:** [gateway-schema 事件契约](./gateway-schema-event-contract.md), [gateway-wire-v1 架构设计（历史页）](../../architecture/gateway-wire-v1-architecture.md), [Gateway Schema / Protocol 架构设计](../../architecture/gateway-schema-architecture.md)

## 定位

本页不再承载 current-state 事件契约，只保留 `gateway-wire-v1` 作为历史工作名的说明。

## 迁移结论

- current-state 主契约路径已切换到 [gateway-schema 事件契约](./gateway-schema-event-contract.md)
- `packages/test-support` 的文档契约测试已以 `gateway-schema` 主路径为准
- `gateway-wire-v1` 仅用于解释历史命名和迁移背景，不再作为当前语义真源

## 为什么保留本页

- 便于追踪旧计划、旧讨论和旧链接中的 `gateway-wire-v1` 命名
- 明确告诉读者：历史工作名已经收口到 `@agent-plugin/gateway-schema`
- 避免继续把旧路径误用为 current-state 主语义页面

## 当前应查看的页面

- 架构语义：`docs/architecture/gateway-schema-architecture.md`
- 事件字段表：`docs/design/interfaces/gateway-schema-event-contract.md`

## 结论

如果你是在找当前 `tool_event.event` 的字段契约，请不要继续使用本页；应直接查看 `gateway-schema-event-contract.md`。
