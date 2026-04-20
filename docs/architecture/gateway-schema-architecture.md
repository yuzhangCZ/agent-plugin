# Gateway Schema / Protocol 架构设计

**Version:** 0.2  
**Date:** 2026-04-17  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [gateway-wire-v1 架构设计](./gateway-wire-v1-architecture.md), [bridge-runtime-sdk 目标态架构设计](./bridge-runtime-sdk-architecture.md), [三方 Agent Runtime 系统分层架构设计](./third-party-agent-runtime-architecture.md)

## 1. 文档定位

本文是协议层架构真源文档，负责定义三方 Agent 与 AI Gateway 之间的协议层术语与边界。

本文负责定义：

- `GatewayWireProtocol`
- `GatewayDownstreamBusinessRequest`
- `GatewayUplinkBusinessMessage`
- `GatewayToolEventPayload`
- uplink / downstream 的协议层边界
- `status_query`、`invoke.*`、`tool_event`、`tool_done`、`tool_error`、`session_created`、`status_response` 在协议层的角色分工
- 当前态与目标态的协议关系
- `SkillProviderEvent` 是目标态统一来源
- `OpencodeProviderEvent` 是 `GatewayToolEventPayload` 的当前态 / 兼容来源

本文不负责定义：

- `RuntimeCommand`
- Provider SPI
- `bridge-runtime-sdk` 内部模块分层
- projector、sink、registry、facade 的实现细节
- payload 字段表、validator、字面量真源的最终细节

这些更细粒度内容由后续 schema / spec 文档承接。

## 2. 核心术语

### 2.1 `GatewayWireProtocol`

`GatewayWireProtocol` 是 AI Gateway 全量上下行协议的 umbrella term。

它覆盖：

- downstream 业务请求
- uplink 业务消息
- 当前态上下行的 transport / control 消息

### 2.2 `GatewayDownstreamBusinessRequest`

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

`GatewayDownstreamBusinessRequest` 是协议层术语，不等于 Runtime 内部命令模型，也不等于 Provider SPI。

### 2.3 `GatewayUplinkBusinessMessage`

`GatewayUplinkBusinessMessage` 是 Runtime 发往 AI Gateway 的上行业务消息总称。

当前态协议层业务消息集合如下：

```text
GatewayUplinkBusinessMessage
  ├─ tool_event(event: GatewayToolEventPayload)
  ├─ tool_done
  ├─ tool_error
  ├─ session_created
  └─ status_response
```

### 2.4 `GatewayToolEventPayload`

`GatewayToolEventPayload` 是 `tool_event.event` 的协议层 payload family。

当前态它表达的是：

- 需要通过 `tool_event` 发送的上行业务事件载荷
- 当前由 `OpencodeProviderEvent` 承接的已落地 payload 白名单

目标态上，它仍应由 Runtime 统一业务事件模型向协议层投影产生，但这一层尚未在共享 schema 包中完整落地。

### 2.5 `SkillProviderEvent`

`SkillProviderEvent` 是 `bridge-runtime-sdk` 的统一上行业务事件模型。

从协议层角度看，它是目标态 `GatewayToolEventPayload` 的统一来源，而不是协议字段真源本身。

### 2.6 `OpencodeProviderEvent`

`OpencodeProviderEvent` 是 `GatewayToolEventPayload` 的当前态 / 兼容来源。

它只用于承接 legacy 插件路径，不是目标态统一事件语义，也不应被写成 `bridge-runtime-sdk` 的统一内部模型。

## 3. 协议层边界

### 3.1 Downstream

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

这里的关键边界是：

- `GatewayDownstreamBusinessRequest` 是协议层请求总称，不等于 Runtime 内部的 `RuntimeCommand`。
- `status_query` 与 `invoke.*` 共同构成当前下行请求集合，不需要再把 query 强行塞进 command 术语。
- 本文只定义协议层角色分工，不定义 Runtime 如何做 dispatch、registry 校验或 coordinator 收口。

### 3.2 Downstream Request 到可观察结果的协议映射

下行请求与上行结果并不是一一对称的固定 request/response 镜像。当前协议层只固定“可观察结果类别”，不在这里定义 Runtime 内部实现。

| Downstream Request | 协议层角色 | 可观察上行结果类别 |
|---|---|---|
| `status_query` | `query` | `status_response` |
| `invoke.create_session` | `session-control` | `session_created` |
| `invoke.chat` | `run` | `tool_event` / `tool_done` / `tool_error` |
| `invoke.question_reply` | `interaction` | `tool_event(question.replied)`；随后继续进入同一 request run 的后续可观察结果 |
| `invoke.permission_reply` | `interaction` | `tool_event(permission.replied)`；随后继续进入同一 request run 的后续可观察结果 |
| `invoke.close_session` | `session-control` | session effect，无独立固定 success envelope |
| `invoke.abort_session` | `session-control` | 运行时收口结果，无固定独立 success envelope |

### 3.3 Uplink

uplink 表达 Runtime 发往 AI Gateway 的业务消息。

协议层只区分消息角色，不替代 Runtime 语义层：

- `tool_event`：承载 `GatewayToolEventPayload`
- `tool_done`：表示一次 request run 的完成信号
- `tool_error`：表示一次 request run 的失败信号
- `session_created`：表示会话创建请求的结果消息
- `status_response`：表示状态查询请求的结果消息

这里的关键边界是：

- `tool_event.event` 不是全量上行协议
- `tool_done` / `tool_error` 不是 `tool_event` 的子类型
- `session_created` / `status_response` 是独立的 uplink 业务消息，不应被并入 `tool_event`

## 4. Current State

当前态必须明确区分为共享 schema 已落地部分与目标态待补项。

当前事实如下：

- `@agent-plugin/gateway-schema` 是当前已落地、可验证、可消费的 schema package。
- 当前 downstream contract 仍主要以 `status_query` 与 `invoke.*` 的已落地形态为准。
- 当前 `tool_event.event` 的允许 shape 以 `OpencodeProviderEvent` 白名单集合为准。
- `GatewayDownstreamBusinessRequest`、`GatewayUplinkBusinessMessage`、`GatewayTransportControlMessage`、`GatewayWireProtocol` 已在共享 schema 包中落地为独立入口。
- `SkillProviderEvent` 相关协议定义属于目标态待补项。
- `GatewayToolEventPayload` 当前仅等价于 `OpencodeProviderEvent`，不代表目标态完整 family 已落地。

因此，当前态不能被写成：

- `@agent-plugin/gateway-schema` 已完整定义了 `SkillProviderEvent`
- 当前 downstream contract 已完整定义了 Runtime 内部命令模型
- `tool_event.event` 已经覆盖未来所有统一上行业务事件
- 现有 legacy payload 来源已经等同于目标态统一核心模型

## 5. Target State

目标态协议责任链如下：

```text
AI Gateway
  -> GatewayWireProtocol
  -> GatewayDownstreamBusinessRequest
  -> RuntimeCommand
  -> bridge-runtime-sdk

ProviderFact
  -> SkillProviderEvent
  -> GatewayUplinkBusinessMessage
  -> GatewayWireProtocol
```

目标态含义如下：

- `GatewayDownstreamBusinessRequest` 是协议层的正式下行业务请求总称。
- `RuntimeCommand` 是下游 Runtime 消费层概念，不由本文定义。
- `SkillProviderEvent` 是 Runtime 的统一业务事件来源。
- `GatewayUplinkBusinessMessage` 是协议层的正式上行业务消息总称。
- `GatewayToolEventPayload` 是 `tool_event.event` 的目标态 payload family。

在目标态中：

- `status_query` 与 `invoke.*` 共同组成当前下行请求集合。
- 下行请求与上行结果不要求一一对称。
- `tool_event` 只承载需要以事件流方式表达的业务载荷。
- `tool_done`、`tool_error`、`session_created`、`status_response` 继续保留为独立消息类型。
- 协议层术语不受当前实现类型名约束。

## 6. 当前态与目标态的关系

可以把两者理解为：

- `@agent-plugin/gateway-schema`：当前态协议 schema package
- `GatewayWireProtocol`：当前态全量协议 umbrella term
- `GatewayDownstreamBusinessRequest`：当前态下行业务请求总称
- `GatewayUplinkBusinessMessage`：当前态上行业务消息总称
- `GatewayToolEventPayload`：当前态事件 payload family
- `OpencodeProviderEvent`：当前态 / 兼容来源
- `SkillProviderEvent`：目标态统一来源

这意味着：

- 当前态允许 legacy payload source 与 legacy downstream contract 继续存在
- 目标态要求协议概念与宿主历史模型解耦
- 本轮文档重构不等于当前所有协议 shape 已完成迁移

## 7. 架构术语与当前实现命名

本文使用的是架构术语：

- `GatewayWireProtocol`
- `GatewayDownstreamBusinessRequest`
- `GatewayUplinkBusinessMessage`
- `GatewayToolEventPayload`

当前代码中的 `GatewayOutboundMessage`、`GatewaySendPayload`、`GatewayBusinessMessage` 可能与这些术语语义对应，但本轮不要求名称完全一致，也不允许当前实现命名反向约束目标态架构术语。

## 8. 结论

协议层需要回答的问题有两个：

- AI Gateway 向 Runtime 发来的请求，在概念上究竟是什么
- Runtime 发往 AI Gateway 的消息，在概念上究竟是什么

本文给出的答案是：

- 用 `GatewayWireProtocol` 统称全量协议
- 用 `GatewayDownstreamBusinessRequest` 统称下行业务请求
- 用 `GatewayUplinkBusinessMessage` 统称上行业务消息
- 用 `GatewayToolEventPayload` 统称 `tool_event.event` 的目标态 payload family
- 明确区分当前 legacy contract 与目标态统一来源
