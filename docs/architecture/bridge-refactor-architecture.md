# ai-gateway Bridge 重构架构设计

**Version:** 0.3  
**Date:** 2026-03-31  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [0001-plugin-migration-governance.md](../adr/0001-plugin-migration-governance.md), [bridge-refactor-migration-plan.md](./bridge-refactor-migration-plan.md), [gateway-wire-v1-architecture.md](./gateway-wire-v1-architecture.md), [gateway-client-architecture.md](./gateway-client-architecture.md), [message-bridge architecture overview](../../plugins/message-bridge/docs/architecture/overview.md), [OpenClaw protocol sequence](../../plugins/message-bridge-openclaw/docs/protocol-sequence.md), [test-layering.md](../testing/test-layering.md)

## Background

`message-bridge` 与 `message-bridge-openclaw` 当前都直接持有各自的 gateway 协议类型、消息归一化、连接实现与部分兼容逻辑。结果是：

- `ai-gateway` 的上下行 wire shape 在两个插件里重复定义。
- `AkSkAuth`、`GatewayConnection`、连接状态机与重连逻辑在两个插件中重复实现。
- OpenCode / OpenClaw 的宿主差异、gateway 兼容协议、桥接编排逻辑仍然交织在一起。
- 当前 gateway 协议脱胎于 OpenCode 协议，但本轮重构不能修改该外部协议。

本轮重构的目标不是立即产出最终中立协议，而是在不改变外部 `ai-gateway` 协议的前提下，先抽取稳定基础设施，再为后续内部语义解耦留出明确边界。

## Goals

1. 将当前 `ai-gateway` 外部协议冻结为 `gateway-wire-v1`，作为现阶段唯一兼容协议真源。
2. 将连接、鉴权、心跳、重连、READY gating 等稳定基础设施收敛为 `gateway-client`。
3. `message-bridge-openclaw` 的连接语义与 `message-bridge` 对齐，`openclaw` 不保留额外兼容连接分支。
4. 第一阶段只处理重复的协议定义与连接实现，不提前冻结桥内部中立命令名。
5. 后续通过 `bridge-mapper -> bridge-application -> host-adapter` 逐步完成内部语义解耦。
6. 在 mapper / application 引入前，身份语义、capability 决策、compat policy 继续留在插件现有 orchestrator 中。

## Non-Goals

- 不修改 `ai-gateway` 外部协议字段、动作名、消息形状或兼容语义。
- 不在本轮确定最终包名；`gateway-wire-v1`、`gateway-client`、`bridge-mapper`、`bridge-application`、`host-adapter`、`host-plugin` 都只是工作名。
- 不在第一阶段引入最终版共享 orchestrator。
- 不在本轮实现长期 host 统一层。
- 不将 `message-bridge` 的私有连接状态 API 提升为跨插件通用 host 能力。

## Design Principles

### 1. 外部协议冻结，内部语义后移

当前 gateway 协议继续作为唯一外部协议存在，并作为 `gateway-wire-v1` 被完整保留。  
本轮不把它提升为最终中立领域模型，只把它视为兼容协议层。

### 2. 先抽不变部分，再抽有争议的语义

优先收敛：

- gateway message types
- normalizer / validator
- error shape
- 鉴权、连接、心跳、重连、READY gating

后续再收敛：

- `wire-v1 <-> bridge semantics` 映射
- use case / policy / identity / capability decision
- host adapter 统一抽象

### 3. 共享层只承载自己这一层的职责

- `gateway-wire-v1` 只定义结构和校验，不承载 bridge 业务语义。
- `gateway-client` 只负责 transport，不承载 bridge 命令解释。
- `bridge-mapper` 只做协议与内部语义转换，不负责宿主执行。
- `bridge-application` 只做编排和决策，不直接依赖 WebSocket 或 raw host 事件格式。
- `host-adapter` 只实现宿主能力，不再定义新的 gateway 协议真源。

### 4. 旧主叙事降级为历史草案

此前根文档中的 `ai-gateway-bridge-protocol`、`ai-gateway-bridge-sdk`、`bridge-core`、`host-session-sdk` 只代表历史方案探索，不再作为当前实施基线。

## Current State

当前可观察结构可以概括为：

```text
OpenCode/OpenClaw runtime
  -> plugin-specific adapter/orchestrator
  -> plugin-specific protocol normalization
  -> plugin-specific gateway connection
  -> ai-gateway
```

主要问题不是“没有分层”，而是“重复能力没有被收敛”：

- 两个插件各自维护一套 downstream / transport contracts。
- 两个插件各自维护一套 `AkSkAuth`、`GatewayConnection`、连接状态机。
- gateway 协议兼容行为与宿主差异仍然绑在各自插件内部。

## Target Layering

完整演进后的目标工作分层如下：

```text
host-plugin
  -> host-adapter
  -> bridge-application
  -> bridge-mapper
  -> gateway-client
  -> gateway-wire-v1
```

在依赖语义上：

- `gateway-wire-v1` 是当前对外兼容协议层。
- `gateway-client` 是 gateway transport 适配层。
- `bridge-mapper` 是外部 wire 与内部语义的边界层。
- `bridge-application` 是桥接应用编排层。
- `host-adapter` 是宿主实现层。
- `host-plugin` 是插件入口与装配层。

本轮只冻结第一阶段实际落地的两层：`gateway-wire-v1` 与 `gateway-client`。其中 `gateway-client` 当前已经以共享包和 `legacy` 兼容入口形式接入两个插件。

## Layer Responsibilities

| Layer | 角色 | 当前阶段状态 | 应包含 | 不应包含 |
|---|---|---|---|---|
| `gateway-wire-v1` | 当前 `ai-gateway` 兼容协议真源 | 第一阶段落地 | message types、payload types、normalizer、validator、error shape | capability decision、compat policy、session identity 语义 |
| `gateway-client` | gateway transport 适配层 | 第一阶段落地 | `AkSkAuth`、`GatewayConnection`、register、heartbeat、reconnect、READY gating、typed send/receive | `onInvoke()`、`onStatusQuery()` 这类 bridge 语义 API、host policy |
| `bridge-mapper` | `wire-v1` 与内部语义转换层 | 后续阶段 | `invoke.chat` 到内部命令的映射、上行事件投影 | 宿主执行、连接状态机 |
| `bridge-application` | 桥接编排与决策层 | 后续阶段 | use case、policy、identity model、capability decision、compat policy | raw gateway parsing、WebSocket、raw host event extraction |
| `host-adapter` | 宿主实现层 | 后续阶段 | OpenCode / OpenClaw 能力实现、host event 适配、host session 调用 | gateway 协议真源、跨宿主编排 |
| `host-plugin` | 插件入口与装配层 | 一直存在 | 依赖注入、配置、插件生命周期、少量宿主私有薄逻辑 | 再维护一套共享基础设施真源 |

## Phase 1 Boundary

第一阶段只允许落地以下目标：

- 将当前 gateway message types、normalizer、validator、error shape 收敛到 `gateway-wire-v1`
- 将 `AkSkAuth`、`GatewayConnection`、连接状态机、重连与 READY gating 收敛到 `gateway-client`
- 让两个插件依赖共享的协议层与连接层

第一阶段明确不做：

- 不定义 bridge 内部中立命令名
- 不引入共享 `mapper`
- 不引入共享 `application`
- 不引入共享 `host-adapter`
- 不将 identity/capability/compat policy 提前塞进共享层

## Ownership Before Mapper/Application

在 `bridge-mapper` 与 `bridge-application` 尚未引入前，以下职责继续由插件内现有 orchestrator 持有：

- `toolSessionId`、`welinkSessionId`、`hostSessionId` 的业务语义解释
- `permission_reply` / `question_reply` 是否支持的判断
- `tool_done` compat、`session.idle` fallback、unsupported/fail-closed 的决策
- OpenCode / OpenClaw 宿主差异的最终业务处理

共享层在第一阶段只承载结构，不承载这些决策。

补充约束：

- `sessionKey` 继续只存在于 OpenClaw 插件私有实现中。
- `chat` 继续作为 `wire-v1` 外部动作名存在，不提前冻结内部替代命令名。

## Plugin-Private Status API Boundary

`message-bridge` 现已补充一套**插件私有**连接状态 API，用于三方集成在 UI 中展示“连接中 / 已连接 / 不可用”。

这套 API 的定位必须保持清晰：

- 它属于 `host-plugin` 私有能力，不属于 `gateway-wire-v1`、`gateway-client`、`bridge-mapper` 或未来共享 `host-adapter` 的一部分。
- 它不定义宿主通用插件状态中心，也不要求其他插件复用同一套接口。
- 它不改变任何 `ai-gateway` 外部协议，也不复用 `status_query -> status_response` 作为宿主侧状态读取手段。

换句话说，这个状态 API 解决的是“本插件当前是否连通 gateway，以及为什么不可用”，而不是“长期 host 统一层如何暴露插件状态”。

### Private Status Model

当前 `message-bridge` 私有状态模型固定为：

```ts
type MessageBridgePhase = 'connecting' | 'ready' | 'unavailable';

type MessageBridgeUnavailableReason =
  | 'uninitialized'
  | 'disabled'
  | 'config_invalid'
  | 'disconnected'
  | 'server_disconnected'
  | 'register_rejected'
  | 'startup_failed';

interface MessageBridgeStatusSnapshot {
  connected: boolean;
  phase: MessageBridgePhase;
  unavailableReason: MessageBridgeUnavailableReason | null;
  willReconnect: boolean | null;
  lastError: string | null;
  updatedAt: number;
  lastReadyAt: number | null;
}
```

其中：

- `phase` 只表达主状态分类。
- `unavailableReason` 只表达不可用原因。
- `willReconnect` 单独表达后续是否会自动恢复，避免把“谁导致断开”和“是否重连”压进同一个枚举。

### Status Semantics

该私有状态模型遵循以下不变量：

- `phase='ready'` 时，`connected=true`，`unavailableReason=null`，`willReconnect=null`
- `phase='connecting'` 时，`connected=false`，`unavailableReason=null`，`willReconnect=true`
- `phase='unavailable'` 时，`connected=false`，`unavailableReason!=null`，`willReconnect=false`

其中连接成功的唯一判定仍然是：**gateway 进入 `READY`，即收到 `register_ok`**。

### Why `willReconnect` Exists

仅使用 `unavailableReason` 无法稳定表达下面两类不同场景：

- 网络或链路抖动导致连接中断，但 runtime 仍会自动重连
- 服务端主动关闭连接，且 runtime 明确不会再重连

如果把这两类信息都编码进 `reason`，枚举会快速膨胀为：

- `network_disconnected_reconnecting`
- `server_disconnected_no_reconnect`
- `register_rejected_no_reconnect`

这会让状态模型同时承担“原因”和“后续动作”两个维度，破坏可扩展性。  
因此这里明确拆成：

- `unavailableReason`：为什么当前不可用
- `willReconnect`：后续是否自动恢复

### Example: Server-Initiated Disconnect Without Reconnect

当出现“服务端主动断开，且当前不会重连”的场景时，私有状态应表达为：

```json
{
  "connected": false,
  "phase": "unavailable",
  "unavailableReason": "server_disconnected",
  "willReconnect": false,
  "lastError": "gateway closed the connection",
  "updatedAt": 1711814400000,
  "lastReadyAt": 1711814300000
}
```

与之相对，如果 runtime 判断当前断连后仍会自动恢复，则状态应转为：

```json
{
  "connected": false,
  "phase": "connecting",
  "unavailableReason": null,
  "willReconnect": true,
  "lastError": null,
  "updatedAt": 1711814400000,
  "lastReadyAt": 1711814300000
}
```

这两种状态必须在 UI 和集成方语义上明确区分：

- 前者表示“当前不可用，且不会自行恢复”
- 后者表示“当前未就绪，但 runtime 仍在恢复中”

### Layer Placement

在当前分层里，这个私有状态能力应位于：

```text
host-plugin
  -> plugin-private status store / status adapter
  -> plugin runtime
  -> gateway-client
  -> gateway-wire-v1
```

它的职责边界如下：

- `gateway-client` 只负责发出连接状态和关闭事件
- `message-bridge` runtime 负责将 transport 事件映射为私有状态快照
- 状态 store 负责查询、订阅、去重和快照发布
- 集成方 UI 只消费该私有状态快照，不直接依赖 runtime 或 gateway 对象

该设计允许当前需求快速落地，同时不提前冻结未来共享 host 状态接口。

## Current And Future Flows

### Phase 1 Flow

```text
ai-gateway
  -> gateway-client
  -> plugin-specific orchestrator/runtime
  -> host runtime
```

当前共享层只解决：

- 怎么定义当前 gateway 协议
- 怎么稳定连接 gateway

不改变插件内部现有编排。

### Future Flow

```text
ai-gateway
  -> gateway-client
  -> bridge-mapper
  -> bridge-application
  -> host-adapter
  -> host-plugin / host runtime
```

此时才会逐步将：

- `wire-v1` 与内部中立语义解耦
- identity 与 capability decision 收敛到应用层
- 宿主实现差异收敛到 adapter 层

## Compatibility Rules

本轮文档重构和后续阶段推进必须保持以下外部行为不变：

1. 不改变当前插件身份与安装路径。
2. 不改变当前 `ai-gateway` wire shape 的外部可观察语义。
3. 不改变 `status_query -> status_response` 的 envelope-free 行为。
4. 不改变 `chat -> tool_event -> tool_done/tool_error` 的当前链路结果。
5. 不改变 `session.idle` 与 compat `tool_done` 的当前兼容关系。
6. 不改变 `permission_reply / question_reply` 的当前支持与 fail-closed 行为。
7. 不改变 `create_session` 的当前约束。
8. 新增 `message-bridge` 私有状态 API 不得改变 `ai-gateway` 外部协议或 `status_query -> status_response` 现有语义。

## Source Of Truth

本文件建立后，以下规则生效：

- 根级架构文档是当前重构路线的唯一实施口径。
- 旧的 `protocol / sdk / core / host-session-sdk` 主叙事视为历史草案，不再作为实施依据。
- `plugins/message-bridge/docs/` 与 `plugins/message-bridge-openclaw/docs/` 继续作为各自插件现状和兼容行为的背景文档。
- 本文件只冻结当前阶段的分层策略和阶段边界，不提前冻结未来内部中立命令名与最终包名。

## Deferred Decisions

以下内容明确后移，不在本阶段冻结：

- `bridge-mapper` 的最终命令/事件命名
- `bridge-application` 的最终目录与导出形态
- `host-adapter` 的最终共享接口粒度
- 长期 host 统一层的命名、目录与包边界
- 是否将 `message-bridge` 私有状态 API 演进为跨插件共享状态接口
- 是否需要在未来引入新的中立 gateway 协议版本
