# 私有 Status API 契约

**Version:** 1.0
**Date:** 2026-04-22
**Status:** Active
**Owner:** message-bridge maintainers
**Related:** `./protocol-contract.md`, `../../product/prd.md`, `../../architecture/overview.md`

## In Scope

- `getMessageBridgeStatus()` 的公开读取契约
- `subscribeMessageBridgeStatus()` 的订阅契约
- `MessageBridgeStatusSnapshot` 字段与公开语义
- 私有 status API 与 `status_query/status_response` 的边界

## Out of Scope

- `gateway-client` 内部状态机实现细节
- `BridgeRuntimeStatusAdapter` 的内部输入类型
- 服务端状态聚合逻辑
- gateway wire 协议扩展

## External Dependencies

- `@agent-plugin/gateway-client` 提供连接状态与错误事实
- 宿主 `app.log()` 提供可选状态 API 日志出口

## 概述

私有 Status API 只服务插件内部与宿主内读取，不属于 gateway 外部协议。

公开导出固定为：

```ts
function getMessageBridgeStatus(): MessageBridgeStatusSnapshot;

function subscribeMessageBridgeStatus(
  listener: (snapshot: MessageBridgeStatusSnapshot) => void,
): () => void;
```

约束：

- `getMessageBridgeStatus()` 返回当前最新快照，不抛异常
- `subscribeMessageBridgeStatus()` 返回取消订阅函数
- 订阅只接收语义变化后的快照
- 私有状态不会进入 `status_response`

## 快照结构

```ts
export type MessageBridgePhase = 'connecting' | 'ready' | 'unavailable';

export type MessageBridgeUnavailableReason =
  | 'not_ready'
  | 'disabled'
  | 'config_invalid'
  | 'plugin_failure'
  | 'server_failure'
  | 'network_failure';

export interface MessageBridgeStatusSnapshot {
  connected: boolean;
  phase: MessageBridgePhase;
  unavailableReason: MessageBridgeUnavailableReason | null;
  willReconnect: boolean | null;
  lastError: string | null;
  updatedAt: number;
  lastReadyAt: number | null;
}
```

## 字段语义

| 字段 | 类型 | 说明 |
|---|---|---|
| `connected` | `boolean` | 当前是否已进入 bridge 对外可用的 ready 态 |
| `phase` | `connecting \| ready \| unavailable` | 公开连接阶段 |
| `unavailableReason` | `MessageBridgeUnavailableReason \| null` | 仅 `phase='unavailable'` 时存在 |
| `willReconnect` | `boolean \| null` | `connecting=true` 时为 `true`，`ready` 时为 `null`，`unavailable` 时为 `false` |
| `lastError` | `string \| null` | 最近一次不可用原因对应的公开错误文本 |
| `updatedAt` | `number` | 当前快照发布时间戳（毫秒） |
| `lastReadyAt` | `number \| null` | 最近一次进入 `ready` 的时间戳 |

## 不可用原因语义

| 值 | 说明 |
|---|---|
| `not_ready` | 默认初始态或显式 reset 后的基线态 |
| `disabled` | 配置明确禁用 bridge |
| `config_invalid` | 配置加载或校验失败 |
| `plugin_failure` | 进入稳定连接生命周期前的非配置类内部失败 |
| `server_failure` | 服务端拒绝、握手拒绝或明确服务端失败 |
| `network_failure` | transport 超时、socket 错误、异常 close、连接失败 |

补充规则：

- `not_ready` 只用于默认初始态和显式 reset 后
- 运行中失败不会回落为 `not_ready`
- `server_failure` 优先级高于后续 `network_failure`

## 订阅语义

- 监听器接收的是当前完整快照
- 若仅 `updatedAt` 变化、其余语义字段不变，则不重复通知
- 监听器抛错不会中断其他监听器

## 与协议边界

- `status_query` 仍属于 gateway 外部协议
- `status_response` 仍只承诺返回 `opencodeOnline:boolean`
- 私有 Status API 是插件导出 API，不属于 gateway wire shape
