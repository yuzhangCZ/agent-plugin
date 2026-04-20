# gateway-wire-v1 模块设计（历史工作名）

**Version:** 1.1  
**Date:** 2026-04-20  
**Status:** Historical Alias  
**Owner:** agent-plugin maintainers  
**Related:** [Gateway Schema / Protocol 架构设计](../architecture/gateway-schema-architecture.md), [gateway-schema 事件契约](./interfaces/gateway-schema-event-contract.md), [gateway-wire-v1 架构设计（历史页）](../architecture/gateway-wire-v1-architecture.md)

## 定位

本页只保留 `gateway-wire-v1` 作为历史模块工作名的说明，不再作为 current-state 模块设计真源。

## 历史结论

`gateway-wire-v1` 曾用于描述“冻结当前对外协议”的共享层设计；当前包名和主路径已经统一收口为 `@agent-plugin/gateway-schema`。

## 当前阅读入口

- current-state 协议语义：`docs/architecture/gateway-schema-architecture.md`
- current-state 事件契约：`docs/design/interfaces/gateway-schema-event-contract.md`

## 为什么不再维护本页为主页面

- 当前契约测试已经切到 `gateway-schema` 主路径
- `gateway-wire-v1` 容易被误读为仍然存在的主包名或主 API 命名
- 历史页面继续承载 current-state 细节会制造双真源

## 结论

如果需要了解当前模块边界和契约，请以 `gateway-schema` 页面为准；本页仅用于解释历史命名，不再表达 current-state 设计结论。
