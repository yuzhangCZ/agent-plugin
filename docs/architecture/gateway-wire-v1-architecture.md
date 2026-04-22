# gateway-wire-v1 架构设计（历史工作名）

**Version:** 1.1  
**Date:** 2026-04-20  
**Status:** Historical Alias  
**Owner:** agent-plugin maintainers  
**Related:** [Gateway Schema / Protocol 架构设计](./gateway-schema-architecture.md), [gateway-schema 事件契约](../design/interfaces/gateway-schema-event-contract.md), [gateway-wire-v1 模块设计（历史页）](../design/gateway-wire-v1-module-design.md)

## 定位

本页用于解释 `gateway-wire-v1` 这一历史工作名如何收口到当前的 `@agent-plugin/gateway-schema`。它不再承担 current-state 协议架构真源职责。

## 历史背景

早期方案用 `gateway-wire-v1` 指代“冻结当前对外协议”的共享层。随着 schema 包正式落地，当前主路径已经切换为 `gateway-schema`，对应的主语义文档也改为：

- `docs/architecture/gateway-schema-architecture.md`
- `docs/design/interfaces/gateway-schema-event-contract.md`

## 需要记住的迁移结论

- `GatewayWireProtocol` 是 current-state 全量协议 umbrella term
- `GatewayUpstreamTransportMessage` 是 upstream-only transport union
- `gateway-wire-v1` 不再是 current-state 主页面或主路径

## 历史页保留范围

本页只保留以下信息：

- 历史命名来源
- 迁移后的主路径映射
- 阅读旧计划、旧讨论、旧链接时的语义对照

本页不再维护：

- 当前字段表
- 当前事件白名单
- 当前测试对齐结论
- current-state 协议边界的最终表述

## 当前应查看的页面

- 协议架构主语义：`docs/architecture/gateway-schema-architecture.md`
- 事件契约主路径：`docs/design/interfaces/gateway-schema-event-contract.md`

## 结论

`gateway-wire-v1` 现在只表示历史工作名。凡是涉及 current-state 协议边界、契约测试或事件字段表，均应回到 `gateway-schema` 主路径。
