# 三方 Agent Runtime 系统分层架构设计

**Version:** 0.6  
**Date:** 2026-04-17  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [Gateway Schema / Protocol 架构设计](./gateway-schema-architecture.md), [bridge-runtime-sdk 目标态架构设计](./bridge-runtime-sdk-architecture.md), [bridge-runtime-sdk 对外集成文档](../design/interfaces/bridge-runtime-sdk-integration.md)

## 1. 文档定位

本文是三方 Agent 方案的系统级责任链文档，面向跨模块设计、架构评审与边界讨论。

本文只负责定义：

- host integration、runtime、gateway schema / protocol、gateway-client 的边界
- 为什么要拆 `ProviderFact`、`SkillProviderEvent`、`GatewayUplinkBusinessMessage`
- 当前态与目标态的系统级差异
- 跨层责任链

本文不负责定义：

- Provider SPI 细节
- SDK 内部模块设计细节
- 协议字段表
- `GatewayToolEventPayload` 的具体 shape 集合

## 2. 系统级分层

### 2.1 Host Integration

host integration 负责：

- 对接具体宿主 SDK / API
- 吸收宿主私有标识、宿主错误与宿主原生事件
- 把宿主原生事件整理为 `ProviderFact`
- 响应 Runtime 下发的命令

### 2.2 Runtime

Runtime 负责：

- 接收协议层下行请求并收敛成内部命令
- 校验并编排 `ProviderFact`
- 维护 request run、outbound、interaction 的运行时闭环
- 派生统一的 `SkillProviderEvent`
- 把内部事件投影为 `GatewayUplinkBusinessMessage`

### 2.3 Gateway Schema / Protocol

gateway schema / protocol 负责：

- 定义 `GatewayWireProtocol`
- 定义 `GatewayDownstreamBusinessRequest`
- 定义 `GatewayUplinkBusinessMessage`
- 定义 `GatewayToolEventPayload`
- 说明上下行消息在协议层的角色分工

它不负责解释宿主语义，也不负责管理 Runtime 状态机。

### 2.4 Gateway Client

`gateway-client` 负责：

- 建链与断链
- 鉴权与 register handshake
- READY gating
- heartbeat
- reconnect
- 协议边界发送与接收

它不负责宿主事实归一化，也不负责运行时业务语义。

## 3. 为什么必须拆三层模型

### 3.1 `ProviderFact`

`ProviderFact` 回答的是「宿主已经发生了什么」。

它的目标是稳定表达宿主事实，而不是直接暴露给 AI Gateway 的最终协议。

### 3.2 `SkillProviderEvent`

`SkillProviderEvent` 回答的是「Runtime 认定上层应该看到什么业务事件」。

它是 Runtime 内部统一上行业务事件模型，用于承接事实校验、状态推进和业务语义派生。

### 3.3 `GatewayUplinkBusinessMessage`

`GatewayUplinkBusinessMessage` 回答的是「这些业务语义如何被装进网关上行消息」。

它是协议层视角的业务消息总称，不应与 Runtime 内部事件模型混同。

### 3.4 为什么下行也要拆两层

`GatewayDownstreamBusinessRequest` 回答的是「AI Gateway 请求 Runtime 做什么」；`RuntimeCommand` 回答的是「Runtime 内部决定如何编排这些请求」。

两者不能混为一层，原因有三点：

- 协议层需要保留网关视角的请求语言，例如 `status_query` 与 `invoke.*`。
- Runtime 需要自己的应用层语言，用来表达内部真正执行的动作，例如查询状态、启动 request run、回复挂起交互、关闭会话、中止执行。
- Provider SPI 只应表达宿主动作，不应直接承载网关协议语义。

如果不拆这两层，协议请求就会直接压到 Runtime / Provider 边界，`reply*`、`abort`、`close` 这类需要运行时校验、路由与收口的请求，也会被误写成“协议请求直接等于宿主动作”。

因此，系统级下行责任链必须稳定区分：

- `GatewayDownstreamBusinessRequest`
  网关请求 Runtime 做什么
- `RuntimeCommand`
  Runtime 内部如何编排这些请求
- Provider SPI / host integration
  如何把动作应用到底层宿主

## 4. 系统级责任链

### 4.1 上行责任链

统一责任链如下：

```text
宿主原生事件
  -> host integration
  -> ProviderFact
  -> bridge-runtime-sdk
  -> SkillProviderEvent
  -> GatewayUplinkBusinessMessage
  -> GatewayWireProtocol
  -> gateway-client send
  -> AI Gateway
```

每一层只回答一个问题：

- host integration：宿主发生了什么
- Runtime：平台内部应认定什么业务语义
- gateway schema / protocol：这些业务语义如何成为网关消息
- `gateway-client`：这些消息如何可靠发出

### 4.2 下行责任链

系统级下行责任链如下：

```text
AI Gateway
  -> gateway-client
  -> GatewayWireProtocol
  -> GatewayDownstreamBusinessRequest
  -> RuntimeCommand
  -> Provider SPI / host integration
  -> 宿主执行
```

每一层只回答一个问题：

- `gateway-client`：如何稳定接收协议边界消息
- gateway schema / protocol：网关请求 Runtime 做什么
- Runtime：内部该如何编排与校验这些请求
- Provider / host integration：如何把动作应用到底层宿主

关键约束如下：

- `GatewayDownstreamBusinessRequest` 是协议层请求，不等于 Runtime 内部命令。
- `RuntimeCommand` 是 Runtime 内部模型，不等于 Provider SPI。
- 下行请求与上行结果并非一一对称，不能把系统理解成纯 request/response 镜像模型。

## 5. Current State

当前态仍以已落地的 legacy wire contract 和现有发送链路为中心，主要特征是：

- `gateway-wire-v1` 冻结的是当前已落地的历史协议边界
- 宿主侧事实、Runtime 语义、协议消息之间仍有概念耦合
- 读者容易把 `tool_event.event` 误解为整个上行业务协议
- 读者也容易把 `status_query` 与 `invoke.*` 误解为“直接驱动 Provider SPI 的协议字面量”

这意味着当前态的主要问题不是消息无法发送，而是文档责任链不够清晰。

## 6. Target State

目标态把系统责任拆成四个明确边界：

- host integration：宿主接入与事实收口
- `bridge-runtime-sdk`：运行时语义与业务编排
- gateway schema / protocol：协议层真源
- `gateway-client`：transport 与可靠发送

在目标态里：

- `ProviderFact` 不等于协议消息
- `GatewayDownstreamBusinessRequest` 不等于 Runtime 内部命令
- `SkillProviderEvent` 不等于 `tool_event.event` 的当前全部落地形状
- `GatewayUplinkBusinessMessage` 不等于单一 `tool_event`
- 下行请求与上行结果不要求形成固定的对称镜像

## 7. 架构术语与当前实现命名

本文使用的是目标态架构术语：

- `GatewayWireProtocol`
- `GatewayDownstreamBusinessRequest`
- `GatewayUplinkBusinessMessage`
- `GatewayToolEventPayload`
- `RuntimeCommand`

当前代码中的 `GatewayOutboundMessage`、`GatewaySendPayload`、`GatewayBusinessMessage` 可能与其语义对应，但本轮不要求名称完全一致，也不允许当前实现命名反向约束目标态架构术语。

## 8. 结论

系统级上必须稳定区分 6 个问题：

- 宿主发生了什么
- 网关请求 Runtime 做什么
- Runtime 内部怎样编排这些请求
- Provider / host integration 如何把动作应用到底层宿主
- Runtime 认定了什么业务语义
- 协议层如何表达这些语义

这就是本文与 [bridge-runtime-sdk 目标态架构设计](./bridge-runtime-sdk-architecture.md) 以及 [Gateway Schema / Protocol 架构设计](./gateway-schema-architecture.md) 的分工边界。
