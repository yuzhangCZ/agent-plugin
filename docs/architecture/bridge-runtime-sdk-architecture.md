# bridge-runtime-sdk 目标态架构设计

**Version:** 0.5  
**Date:** 2026-04-17  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [三方 Agent Provider 对外接口文档 v2](../design/interfaces/third-party-agent-provider-v2.md), [Gateway Schema / Protocol 架构设计](./gateway-schema-architecture.md), [三方 Agent Runtime 系统分层架构设计](./third-party-agent-runtime-architecture.md)

## 1. 文档定位

本文是 `bridge-runtime-sdk` 的目标态架构文档，面向 SDK 实现者与架构评审者。

本文负责定义：

- `GatewayDownstreamBusinessRequest -> RuntimeCommand` 的 intake / dispatch 链路
- `ProviderFact -> SkillProviderEvent` 的内部投影链路
- `SkillProviderEvent -> GatewayUplinkBusinessMessage` 的内部投影链路
- facade、core、projector、sink、registry、ports、adapters 的职责分工
- request run、outbound、interaction 的运行时协作边界
- `bridge-runtime-sdk` 如何依赖协议层概念

本文不负责定义：

- Provider SPI 的正式对外语义
- `GatewayWireProtocol`、`GatewayDownstreamBusinessRequest`、`GatewayUplinkBusinessMessage`、`GatewayToolEventPayload` 的字段真源
- 系统级 bounded context 总览
- 插件迁移路径、当前代码类型到目标术语的一一映射表

阅读顺序建议：

1. 先看 [三方 Agent Runtime 系统分层架构设计](./third-party-agent-runtime-architecture.md) 理解系统边界。
2. 再看本文理解 SDK 内部责任链。
3. 最后看 [Gateway Schema / Protocol 架构设计](./gateway-schema-architecture.md) 对齐协议层术语。

## 2. 背景

当前仓库仍存在插件内实现与目标态架构并存的情况。本文只描述 `bridge-runtime-sdk` 应收敛到的目标态，不把现状实现细节带入主模型。

## 3. 核心模型与责任链

### 3.1 上行责任链

`bridge-runtime-sdk` 的核心职责之一，是把宿主事实流收敛成统一的上行业务消息。

目标态责任链如下：

```text
ProviderFact
  -> FactToSkillEventProjector
  -> SkillProviderEvent
  -> SkillEventToGatewayMessageProjector
  -> GatewayUplinkBusinessMessage
  -> GatewayOutboundSink
```

其中：

- `ProviderFact` 是宿主适配层提供给 Runtime 的正式事实输入。
- `SkillProviderEvent` 是 `bridge-runtime-sdk` 的统一上行业务事件模型。
- `GatewayUplinkBusinessMessage` 是 Runtime 发往 AI Gateway 的上行业务消息总称。

补充链路：

- `createSession()`、`health()` 等命令结果，不经 `SkillProviderEvent` 主链路，分别投影为 `session_created`、`status_response`。
- request run 的终态收口结果，单独投影为 `tool_done` 或 `tool_error`。

### 3.2 下行 intake / dispatch 链路

`bridge-runtime-sdk` 的另一个核心职责，是把协议层下行业务请求收敛成 Runtime 内部可编排的命令模型。

目标态责任链如下：

```text
GatewayCommandSource
  -> GatewayDownstreamBusinessRequest
  -> RuntimeCommand
  -> RuntimeCommandDispatcher
  -> coordinators / Provider SPI
```

其中：

- `GatewayDownstreamBusinessRequest` 是协议层下行业务请求总称。
- `RuntimeCommand` 是 Runtime 内部统一下行模型。
- `RuntimeCommand` 使用 Runtime 语义操作命名，不复用协议字面量，也不等于 Provider SPI。

补充说明：

- `GatewayCommandSource` 是沿用当前实现的 port 命名。
- 在目标态语义上，它向 Runtime 提供的是 `GatewayDownstreamBusinessRequest`，而不是已经完成内部收敛的 `RuntimeCommand`。
- `RuntimeCommand` 仍然是 Runtime intake / dispatch 之后的内部应用层模型。

当前闭合集合如下：

```text
RuntimeCommand
  ├─ query_status
  ├─ create_session
  ├─ start_request_run
  ├─ reply_question
  ├─ reply_permission
  ├─ close_session
  └─ abort_execution
```

`GatewayDownstreamBusinessRequest` 到 `RuntimeCommand` 的当前映射如下：

| GatewayDownstreamBusinessRequest | RuntimeCommand | Runtime 路径 | Provider SPI / 可观察结果 |
|---|---|---|---|
| `status_query` | `query_status` | query 路径 | `health()` -> `status_response` |
| `invoke.create_session` | `create_session` | session-control 路径 | `createSession()` -> `session_created` |
| `invoke.chat` | `start_request_run` | request run 路径 | `runMessage()` -> `tool_event` / `tool_done` / `tool_error` |
| `invoke.question_reply` | `reply_question` | interaction 路径 | pending interaction 校验 -> `replyQuestion()` -> continuation effect |
| `invoke.permission_reply` | `reply_permission` | interaction 路径 | pending interaction 校验 -> `replyPermission()` -> continuation effect |
| `invoke.close_session` | `close_session` | session-control 路径 | `toolSessionId` 校验 -> `closeSession()` -> session effect |
| `invoke.abort_session` | `abort_execution` | request run / session-control 协调路径 | `abortSession()` -> 运行时收口结果 |

## 4. 模块职责

### 4.1 Facade

Facade 负责：

- 暴露统一创建与启动入口
- 装配默认 adapters
- 管理 Provider 注册与 SDK 生命周期

Facade 不负责：

- 承载 request run / outbound / interaction 规则
- 直接派生 `SkillProviderEvent`
- 直接拼装协议层 payload

### 4.2 Runtime Core

Runtime Core 负责：

- 接收 `GatewayDownstreamBusinessRequest`
- 把协议层下行请求转换为 `RuntimeCommand`
- 调用 `RuntimeCommandDispatcher`
- 校验 `ProviderFact`
- 管理 request run、outbound、interaction 的运行时状态
- 触发 projector 与 sink

Runtime Core 是业务编排中心，但不应退化成包含所有细节规则的 God Object。

### 4.3 RuntimeCommandDispatcher

`RuntimeCommandDispatcher` 负责把 `RuntimeCommand` 分发给正确的运行时路径。

职责划分如下：

- `query_status` -> 健康查询路径 -> `health()`
- `create_session` -> session-control 路径 -> `createSession()`
- `start_request_run` -> request run 路径 -> `runMessage()`
- `reply_question` / `reply_permission` -> interaction coordinator 先做 pending interaction 校验，再调 `replyQuestion()` / `replyPermission()`
- `close_session` -> session-control 路径，Runtime 只要求可提供 `toolSessionId`，再调 `closeSession()`
- `abort_execution` -> request run / session-control 协调路径，调 `abortSession()`；中止后的终态解释与上行收口由 request run coordinator 持有

### 4.4 Projector

Projector 负责表示转换，不负责状态持有或 transport 投递。

目标态至少拆分为：

- `FactToSkillEventProjector`
- `SkillEventToGatewayMessageProjector`
- `GatewayCommandResultProjector`
- `RunTerminalSignalProjector`

职责划分如下：

- `FactToSkillEventProjector`：`ProviderFact -> SkillProviderEvent`
- `SkillEventToGatewayMessageProjector`：`SkillProviderEvent -> tool_event`
- `GatewayCommandResultProjector`：只投影有显式结果消息的命令结果，即 `status_response` / `session_created`
- `RunTerminalSignalProjector`：只处理 request run 相关终态，即 `tool_done` / `tool_error`

### 4.5 Sink

`GatewayOutboundSink` 只负责发送已经封装好的 `GatewayUplinkBusinessMessage`，不负责推断业务语义，也不负责 transport lifecycle。

### 4.6 Registry / Coordinator

Runtime 内部至少需要以下运行时协作对象：

- request run coordinator
- outbound coordinator
- interaction coordinator
- session runtime registry
- active message registry

这些对象分别管理局部规则，避免把全部状态推进逻辑堆进 Runtime Core。

与下行路径直接相关的边界如下：

- interaction coordinator / pending interaction registry 持有 `reply_question` / `reply_permission` 的前置校验权
- request run coordinator 持有 `abort_execution` 之后的终态解释与上行收口权
- session-control 路径可以依赖 `session runtime registry`，但 `close_session` 不要求必须先命中内部 registry 才能派发

### 4.7 Ports 与 Adapters

Ports 负责定义边界：

- Gateway command source
- Gateway outbound sink
- Provider SPI
- 日志与时钟等运行时依赖

Adapters 负责接线：

- Provider adapter 把宿主能力映射成 Provider SPI
- Gateway adapter 把协议层 `GatewayDownstreamBusinessRequest` 交给 `GatewayCommandSource`
- Gateway adapter 把上行业务消息交给 `gateway-client`

Provider adapter 与 Gateway adapter 都不应承载 Runtime 语义本身。

## 5. 三个运行时子域

### 5.1 request run

request run 子域负责：

- 活跃 run 索引
- 事实流合法性校验
- `ProviderRun.result()` 终态收口
- 终态到 `tool_done` / `tool_error` 的信号派生
- `abort_execution` 之后的终态解释与上行收口

### 5.2 outbound

outbound 子域负责：

- `emitOutboundMessage()` 的调用约束
- 单会话单活跃 outbound message 约束
- 批次级 `messageId` 一致性
- `message.done` 后禁止续写

### 5.3 interaction

interaction 子域负责：

- `question.ask` / `permission.ask` 的挂起索引
- `replyQuestion()` / `replyPermission()` 成功后的运行时闭环
- `reply_question` / `reply_permission` 的 pending interaction 前置校验
- 交互与消息生命周期之间的协调

## 6. 依赖协议层的方式

`bridge-runtime-sdk` 依赖协议层概念，但不主定义协议层。

依赖关系如下：

```text
host integration
  -> bridge-runtime-sdk
  -> gateway schema / protocol concepts
  -> gateway-client
  -> AI Gateway
```

约束如下：

- SDK 可以引用 `GatewayWireProtocol`、`GatewayDownstreamBusinessRequest`、`GatewayUplinkBusinessMessage`、`GatewayToolEventPayload` 作为边界术语。
- SDK 自身定义 `RuntimeCommand`，但不把它回写成协议层术语。
- SDK 不重复维护协议层概念的字段表、validator 或字面量集合。
- `status_query` / `invoke.*` 以及 `tool_event`、`tool_done`、`tool_error`、`session_created`、`status_response` 的 canonical 概念定义位于 [Gateway Schema / Protocol 架构设计](./gateway-schema-architecture.md)。

## 7. 架构术语与当前实现命名

本文使用的是目标态架构术语：

- `GatewayWireProtocol`
- `GatewayDownstreamBusinessRequest`
- `GatewayUplinkBusinessMessage`
- `GatewayToolEventPayload`
- `RuntimeCommand`

当前代码中的 `GatewayOutboundMessage`、`GatewaySendPayload`、`GatewayBusinessMessage` 可能与这些术语语义对应，但本轮不要求名称完全一致，也不允许当前实现命名反向约束目标态架构术语。

## 8. 结论

`bridge-runtime-sdk` 的目标态边界很明确：

- 它接收 `GatewayDownstreamBusinessRequest`
- 它把协议层下行请求收敛成 `RuntimeCommand`
- 它调度 coordinators 与 Provider SPI 执行命令
- 它接收 `ProviderFact`
- 它派生 `SkillProviderEvent`
- 它把内部业务事件投影成 `GatewayUplinkBusinessMessage`
- 它把协议发送交给下游边界

换言之，SDK 负责运行时语义与业务编排，而不是协议真源本身。
