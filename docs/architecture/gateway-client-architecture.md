# gateway-client 架构设计

**Version:** 0.1  
**Date:** 2026-04-08  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [bridge-refactor-architecture.md](./bridge-refactor-architecture.md), [bridge-refactor-migration-plan.md](./bridge-refactor-migration-plan.md), [gateway-wire-v1-architecture.md](./gateway-wire-v1-architecture.md)

## 背景

`@agent-plugin/gateway-schema` 已经作为第一阶段协议 schema 真源落地，统一了 transport message、downstream normalizer 与协议错误形状。`gateway-client` 在此基础上承接第二阶段共享 transport runtime，把两个插件中重复的 `AkSkAuth`、`GatewayConnection`、READY gating、heartbeat 与 reconnect 收敛为一个共享包。

## 职责边界

`gateway-client` 负责：

- AK/SK 鉴权 payload 生成
- WebSocket 建链与断链
- `register` 发送与 `register_ok` / `register_rejected` 控制帧处理
- READY gating
- heartbeat
- reconnect policy
- transport 观测事件：`stateChange`、`message`、`inbound`、`outbound`、`heartbeat`、`error`
- transport 级结构化异常 `GatewayClientError`

`gateway-client` 不负责：

- 不重新定义 `ai-gateway` wire shape
- 不解释 `chat`、`status_query`、`permission_reply`、`question_reply`
- 不替代插件侧 runtime / orchestrator
- 不接管插件本地 `gateway-wire/*` legacy wrapper
- 不引入宿主统一 application / mapper 语义层

## 与 gateway-schema 的关系

`gateway-schema` 负责“协议是什么、是否合法”。  
`gateway-client` 负责“如何基于这个协议稳定连接和传输”。

当前实现中，`gateway-client` 只通过 `@agent-plugin/gateway-schema` 包入口消费共享协议能力：

- `validateGatewayUplinkBusinessMessage`
- `validateGatewayWireProtocolMessage`
- `normalizeDownstream`
- transport message type literals
- `WireContractViolation`

因此 `gateway-client` 不再维护第二份 transport schema，也不再在插件侧各写一份 control message 校验逻辑。

## 统一连接语义

`message-bridge` 与 `message-bridge-openclaw` 现在共享同一套连接语义，`openclaw` 不再保留本地额外兼容分支。  
连接相关的 preset 由 composition root 显式装配，而不是由各插件本地偷偷覆盖默认值。

这意味着：

- `gateway-client` 的 reconnect contract 以共享 preset 为准。
- `openclaw` 只负责传入自己的业务配置，不再单独定义一套连接容错策略。
- 任何连接语义差异都必须通过工厂装配层显式表达，而不是在插件内部隐式分叉。

## 当前分层

```text
packages/gateway-client/src/
  domain/
  ports/
  adapters/
  application/
  auth/
  errors/
  legacy/
  factory/
  index.ts
```

- `domain/`：连接状态、重连配置、发送上下文、错误契约
- `ports/`：client、events、options、codec、auth、logger 抽象
- `adapters/`：`gateway-schema` codec 与默认 reconnect policy
- `application/`：默认 client runtime / facade
- `auth/`：默认 AK/SK auth provider
- `errors/`：`GatewayClientError`
- `legacy/`：迁移期兼容导出，供两个插件的 connection 层 re-export
- `factory/`：`createGatewayClient`

当前实现已经完成共享包抽取与兼容入口切换，但 `application/DefaultGatewayClient.ts` 仍是过渡态实现，后续需要继续拆出更细粒度的 transport / scheduler / runtime handler。

## 公共 API 与 legacy API

顶层稳定导出：

- `GatewayClient`
- `GatewayClientOptions`
- `GatewayClientEvents`
- `GatewayClientState`
- `GatewaySendContext`
- `GatewayClientError`
- `GatewayClientErrorCode`
- `DefaultAkSkAuth`
- `createAkSkAuthProvider`
- `createGatewayClient`

迁移期兼容导出位于 `@agent-plugin/gateway-client/legacy`：

- `DefaultGatewayConnection`
- `GatewayConnection`
- `GatewayConnectionEvents`
- `GatewayConnectionOptions`
- `GatewaySendLogContext`
- `ConnectionState`

两个插件当前通过 `connection/GatewayConnection.ts` 薄 re-export 指向 `legacy` 子入口，以避免直接暴露内部实现文件路径。

## 运行时契约

- `connect()` 在 WebSocket open 且 `register` 已发送后 resolve，不等待 READY
- 收到 `register_ok` 后进入 READY 并启动 heartbeat
- READY 前 business `send()` 被拒绝
- READY 前 business downstream 不触发 `message`
- `register_rejected` 与 close code `4403` / `4408` / `4409` 不自动重连
- 非手动、非 abort、非 rejection close 按共享 reconnect preset 重连
- reconnect preset 由 composition root 装配，`openclaw` 与 `opencode` 不再保留各自的本地兼容语义

## 异常模型

`GatewayClientError` 统一承接 client/runtime 错误，核心字段：

- `code`
- `category`
- `retryable`
- `details`
- `cause`

首批错误码：

- `GATEWAY_CONNECT_ABORTED`
- `GATEWAY_WEBSOCKET_ERROR`
- `GATEWAY_CLOSED_BEFORE_OPEN`
- `GATEWAY_REGISTER_REJECTED`
- `GATEWAY_NOT_CONNECTED`
- `GATEWAY_NOT_READY`
- `GATEWAY_UNEXPECTED_CLOSE`
- `GATEWAY_PROTOCOL_VIOLATION`

`WireContractViolation` 保持在协议层，不直接暴露为插件 runtime 错误。

## 迁移状态

当前分支已完成：

- 新增 `packages/gateway-client`
- 新增包级契约测试并按 TDD 先红后绿
- `message-bridge` / `message-bridge-openclaw` 的 `connection/*` 切到共享 client
- 保持 `message-bridge` 发布包零运行时依赖

当前分支尚未完成：

- 将 `DefaultGatewayClient` 继续拆成 transport adapter / heartbeat scheduler / reconnect scheduler / runtime handler
- 进一步收紧顶层导出，只保留接口、类型和工厂
- 删除 legacy 兼容入口
