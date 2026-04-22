# 私有 Runtime API 契约

**Version:** 1.0
**Date:** 2026-04-22
**Status:** Active
**Owner:** message-bridge maintainers
**Related:** `./protocol-contract.md`, `../../product/prd.md`, `../../architecture/overview.md`

## In Scope

- `startMessageBridgeRuntime()` 的控制契约
- `stopMessageBridgeRuntime()` 的控制契约
- `getMessageBridgeStatus()` 的公开读取契约
- `subscribeMessageBridgeStatus()` 的订阅契约
- `MessageBridgeStatusSnapshot` 字段与公开语义
- 私有 status API 与 `status_query/status_response` 的边界

## Out of Scope

- `gateway-client` 内部状态机实现细节
- `BridgeRuntimeStatusAdapter` 的内部输入类型
- 动态 hooks 的内部实现细节
- 服务端状态聚合逻辑
- gateway wire 协议扩展

## External Dependencies

- `@agent-plugin/gateway-client` 提供连接状态与错误事实
- `@agent-plugin/gateway-client` 保证启动期 `connect()` reject 的失败已进入 `error` 事件流，且二者语义一致
- 宿主 `app.log()` 提供可选状态 API 日志出口

## 概述

私有 Runtime API 只服务插件内部与宿主内控制和读取，不属于 gateway 外部协议。

对宿主而言，这组接口分成两类：

- 控制接口：启动或停止 runtime
- 状态接口：读取当前状态或订阅状态变化

公开导出固定为：

```ts
function startMessageBridgeRuntime(): Promise<void>;

function stopMessageBridgeRuntime(): void;

function getMessageBridgeStatus(): MessageBridgeStatusSnapshot;

function subscribeMessageBridgeStatus(
  listener: (snapshot: MessageBridgeStatusSnapshot) => void,
): () => void;
```

## 控制接口

### 调用顺序

推荐调用顺序：

1. 先调用 `MessageBridgePlugin(input)` 完成插件加载
2. 需要显式恢复或重新启动时，再调用 `startMessageBridgeRuntime()`
3. 需要显式停止时，调用 `stopMessageBridgeRuntime()`
4. 需要展示当前状态或失败原因时，调用 `getMessageBridgeStatus()` 或订阅 `subscribeMessageBridgeStatus()`

补充规则：

- `startMessageBridgeRuntime()` 只能在插件已加载后调用
- `stopMessageBridgeRuntime()` 可在任意时机幂等调用
- `stopMessageBridgeRuntime()` 调用后，插件不会自动恢复；如需恢复，必须再次显式调用 `startMessageBridgeRuntime()`

### `startMessageBridgeRuntime()`

```ts
function startMessageBridgeRuntime(): Promise<void>;
```

约束：

- 无参接口
- 使用插件最近一次加载时提供的上下文启动 runtime
- 若插件尚未加载过，则 Promise reject
- 每次显式调用都视为新的启动请求
- 若当前 runtime 已在运行或仍在启动，本次调用会先终止上一轮生命周期，再启动新一轮 runtime
- 启动失败时 Promise reject，并同步更新私有状态快照
- 对外 reject 的错误必须带可读 `message`
- 调用方若需要稳定失败分类或展示当前失败状态，应通过 `getMessageBridgeStatus()` 读取，而不是依赖 thrown error 类型

使用方语义：

- Promise resolve 表示本次启动请求已将 runtime 带到 `ready`
- Promise reject 表示本次启动请求未能进入 `ready`
- reject error 只用于即时失败提示，不作为稳定分类模型
- 调用方需要稳定失败分类时，应读取 `getMessageBridgeStatus()`
- 启动成功后，后续连接状态变化仍应通过 `subscribeMessageBridgeStatus()` 观察

### `stopMessageBridgeRuntime()`

```ts
function stopMessageBridgeRuntime(): void;
```

约束：

- 同步 stop
- 若当前存在连接或启动流程，会被立即停止
- 调用后状态重置为默认 `not_ready`
- 调用后插件不会自动恢复 runtime
- 只有再次显式调用 `startMessageBridgeRuntime()` 才能恢复 runtime
- 无 runtime 时允许幂等调用

## 状态读取接口

约束：

- `getMessageBridgeStatus()` 返回当前最新快照，不抛异常
- `subscribeMessageBridgeStatus()` 返回取消订阅函数
- 订阅只接收语义变化后的快照
- `startMessageBridgeRuntime()` 失败后，调用方应优先通过状态接口判断稳定失败类别
- 私有状态不会进入 `status_response`

## 插件加载行为

`MessageBridgePlugin(input)` 仍是宿主标准加载入口。对宿主可依赖的行为如下：

- 插件加载时会尝试一次自动启动
- 若当前 runtime 已在运行或仍在启动，再次加载不会额外创建第二个 runtime
- 插件加载失败后，后续仍可通过 `startMessageBridgeRuntime()` 显式恢复
- 插件加载返回的 hooks 在插件生命周期内保持稳定
- 当 runtime 未启动或不可用时，hooks 收到的事件会被忽略
- 当 runtime 正在启动但尚未进入 `ready` 时，hooks 收到的事件也会被忽略
- hooks 不会因为收到事件而隐式启动 runtime
- 当后续显式 `startMessageBridgeRuntime()` 成功后，同一份 hooks 会恢复事件转发能力

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
| `disabled` | 当前配置禁用了 runtime；`startMessageBridgeRuntime()` 会 reject，hooks 保持可调用但不转发事件 |
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
- 私有 Runtime API 是插件导出 API，不属于 gateway wire shape
