# Gateway Schema / Protocol 架构设计

**Version:** 0.3  
**Date:** 2026-04-20  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [gateway-schema 事件契约](../design/interfaces/gateway-schema-event-contract.md), [gateway-wire-v1 架构设计（历史页）](./gateway-wire-v1-architecture.md), [bridge-runtime-sdk 目标态架构设计](./bridge-runtime-sdk-architecture.md), [三方 Agent Runtime 系统分层架构设计](./third-party-agent-runtime-architecture.md)

## 1. 文档定位

本文是 current-state 协议层的主语义页面，用于定义三方 Agent 与 AI Gateway 之间的共享 schema 术语和边界。

本文负责定义：

- `GatewayWireProtocol`
- `GatewayUpstreamTransportMessage`
- `GatewayDownstreamBusinessRequest`
- `GatewayUplinkBusinessMessage`
- `GatewayToolEventPayload`
- `wire-protocol.ts` / `upstream.ts` / `downstream.ts` 的边界分工
- 当前态与目标态的关系

本文不负责定义：

- `RuntimeCommand`
- Provider SPI
- projector、validator、facade 的实现细节
- 每个 `tool_event.event` 的字段表

当前契约的字段级真源由 [gateway-schema 事件契约](../design/interfaces/gateway-schema-event-contract.md) 承接；`gateway-wire-v1` 系列页面只保留历史背景。

## 2. 参考基线

- `Reference Host SDK: @opencode-ai/plugin@1.2.15`
- `Reference Host SDK: @opencode-ai/sdk@1.2.15`

`@agent-plugin/gateway-schema` 只参考上述版本下当前可观察的宿主行为，不直接把宿主 SDK 类型当作共享协议真源。

## 3. 核心术语

### 3.1 `GatewayWireProtocol`

`GatewayWireProtocol` 是 current-state 全量协议的 umbrella term，并且位于独立的 `wire-protocol.ts` protocol root。

它覆盖：

- `GatewayDownstreamBusinessRequest`
- `GatewayUplinkBusinessMessage`
- `GatewayTransportControlMessage`

它的职责是表达“当前共享 schema 能识别的全部 wire envelope”，而不是表达某一侧方向的子集合。

### 3.2 `GatewayUpstreamTransportMessage`

`GatewayUpstreamTransportMessage` 是 upstream-only transport union，位于 `upstream.ts`。

它只覆盖 plugin -> gateway 方向的 transport envelope，当前态等价于：

```text
GatewayUpstreamTransportMessage
  ├─ GatewayTransportControlMessage
  └─ GatewayUplinkBusinessMessage
```

因此：

- `GatewayUpstreamTransportMessage` 不包含 `GatewayDownstreamBusinessRequest`
- `GatewayUpstreamTransportMessage` 不是 `GatewayWireProtocol` 的同义词
- `GatewayUpstreamTransportMessage` 只描述 upstream transport 边界，不负责代表全量协议

### 3.3 `GatewayDownstreamBusinessRequest`

`GatewayDownstreamBusinessRequest` 是 AI Gateway 发往 Runtime 的下行业务请求总称。

当前可见集合如下：

```text
GatewayDownstreamBusinessRequest
  ├─ status_query
  └─ invoke.*
      ├─ invoke.create_session
      ├─ invoke.chat
      ├─ invoke.close_session
      ├─ invoke.abort_session
      ├─ invoke.question_reply
      └─ invoke.permission_reply
```

它是协议层术语，不等于 Runtime 内部命令模型。

### 3.4 `GatewayUplinkBusinessMessage`

`GatewayUplinkBusinessMessage` 是 Runtime 发往 AI Gateway 的上行业务消息总称。

当前可见集合如下：

```text
GatewayUplinkBusinessMessage
  ├─ tool_event(event: GatewayToolEventPayload)
  ├─ tool_done
  ├─ tool_error
  ├─ session_created
  └─ status_response
```

### 3.5 `GatewayToolEventPayload`

`GatewayToolEventPayload` 是 `tool_event.event` 的协议层 payload family。

当前态它表达的是：

- 需要通过 `tool_event` 发送的上行业务事件载荷
- 当前由 `OpencodeProviderEvent` 承接的已落地 payload 白名单

### 3.6 `SkillProviderEvent`

`SkillProviderEvent` 是目标态 `bridge-runtime-sdk` 的统一上行业务事件模型。

从协议层角度看，它是目标态 `GatewayToolEventPayload` 的统一来源，而不是 current-state 共享 schema 已经落地的字段真源。

### 3.7 `OpencodeProviderEvent`

`OpencodeProviderEvent` 是 `GatewayToolEventPayload` 的 current-state / 兼容来源。

它只用于承接 legacy 插件路径，不应被误写成目标态统一内部模型。

## 4. Current State 边界

### 4.1 当前态 union 关系

当前共享 schema 的关系如下：

```text
GatewayWireProtocol
  ├─ GatewayDownstreamBusinessRequest
  └─ GatewayUpstreamTransportMessage

GatewayUpstreamTransportMessage
  ├─ GatewayTransportControlMessage
  └─ GatewayUplinkBusinessMessage
```

这里的关键点是：

- `GatewayWireProtocol` 是独立 protocol root，不再挂在方向性模块上
- `upstream.ts` 只承载 `GatewayUpstreamTransportMessage`
- `downstream.ts` 只承载 `GatewayDownstreamBusinessRequest`
- `GatewayUpstreamTransportMessage` 与 `GatewayWireProtocol` 有交集，但语义不同

### 4.2 Downstream

downstream 表达 AI Gateway 下发给 Runtime 的业务请求。

当前下行请求按协议层角色可分为 4 类：

- `query`
  - `status_query`
- `run`
  - `invoke.chat`
- `interaction`
  - `invoke.question_reply`
  - `invoke.permission_reply`
- `session-control`
  - `invoke.create_session`
  - `invoke.close_session`
  - `invoke.abort_session`

### 4.3 Uplink / Transport

uplink 表达 Runtime 发往 AI Gateway 的业务消息；transport 则是更窄的一层，负责表达 plugin -> gateway 可传输的 envelope。

当前角色分工如下：

- `tool_event`：承载 `GatewayToolEventPayload`
- `tool_done`：表示一次 request run 的完成信号
- `tool_error`：表示一次 request run 的失败信号
- `session_created`：表示会话创建结果
- `status_response`：表示状态查询结果
- `register` / `register_ok` / `register_rejected` / `heartbeat`：属于 `GatewayTransportControlMessage`

这里的关键边界是：

- `tool_event.event` 不是全量上行协议
- `GatewayUplinkBusinessMessage` 不等于全量协议
- `GatewayUpstreamTransportMessage` 也不等于全量协议
- 只有 `GatewayWireProtocol` 才是 current-state 全量协议 umbrella term

## 5. 当前态与目标态

当前事实如下：

- `@agent-plugin/gateway-schema` 是当前已落地、可验证、可消费的 schema package。
- `GatewayWireProtocol`、`GatewayUpstreamTransportMessage`、`GatewayDownstreamBusinessRequest`、`GatewayUplinkBusinessMessage`、`GatewayTransportControlMessage` 已在共享 schema 包中落地。
- 当前 `tool_event.event` 的允许 shape 以 `OpencodeProviderEvent` 白名单集合为准。
- `SkillProviderEvent` 相关协议定义仍属于目标态待补项。

因此，当前态不能被写成：

- `GatewayUpstreamTransportMessage` 等于全量协议
- `GatewayWireProtocol` 只是 upstream transport 的别名
- `tool_event.event` 已经覆盖未来所有统一上行业务事件
- `OpencodeProviderEvent` 已经等同于目标态统一核心模型

目标态责任链如下：

```text
AI Gateway
  -> GatewayWireProtocol
  -> GatewayDownstreamBusinessRequest
  -> RuntimeCommand
  -> bridge-runtime-sdk

ProviderFact
  -> SkillProviderEvent
  -> GatewayUplinkBusinessMessage
  -> GatewayUpstreamTransportMessage
  -> GatewayWireProtocol
```

## 6. 主路径与历史页

current-state 主路径如下：

- 架构主语义页：`docs/architecture/gateway-schema-architecture.md`
- 事件契约主路径：`docs/design/interfaces/gateway-schema-event-contract.md`

历史页如下：

- `docs/architecture/gateway-wire-v1-architecture.md`
- `docs/design/gateway-wire-v1-module-design.md`
- `docs/design/interfaces/gateway-wire-v1-event-contract.md`

这些 `gateway-wire-v1` 页面只用于解释历史工作名与迁移背景，不再作为当前主语义页面。

## 7. 结论

本文约束当前态协议术语如下：

- 用 `GatewayWireProtocol` 统称 current-state 全量协议
- 用 `GatewayUpstreamTransportMessage` 表示 upstream-only transport union
- 用 `GatewayDownstreamBusinessRequest` 统称下行业务请求
- 用 `GatewayUplinkBusinessMessage` 统称上行业务消息
- 用 `GatewayToolEventPayload` 统称 `tool_event.event` 的当前 payload family

任何把 `gateway-wire-v1` 历史路径继续当作 current-state 主语义页的写法，都是过时表述。
