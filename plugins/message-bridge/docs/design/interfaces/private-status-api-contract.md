# 私有 Runtime API 契约

**Version:** 1.1
**Date:** 2026-04-22
**Status:** Active
**Owner:** message-bridge maintainers
**Related:** `./protocol-contract.md`, `../../product/prd.md`, `../../architecture/overview.md`

## In Scope

- 私有 Runtime API 的同进程宿主访问方式
- `startMessageBridgeRuntime()` 的控制契约
- `stopMessageBridgeRuntime()` 的控制契约
- `getMessageBridgeStatus()` 的读取契约
- `subscribeMessageBridgeStatus()` 的订阅契约
- `MessageBridgeStatusSnapshot` 字段与公开语义

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

私有 Runtime API 面向同进程宿主调用方，用于控制 `message-bridge` runtime 的启动、停止，并读取或订阅 runtime 状态。

这组接口分成两类：

- 控制接口：启动或停止 runtime
- 状态接口：读取当前状态或订阅状态变化

插件模块的运行时导出面只保留插件入口：

- `default export MessageBridgePlugin`
- `named export MessageBridgePlugin`

## 快速接入

`src/index.ts` 被 import 时会注册 `globalThis.__MB_RUNTIME_API__`。宿主应从该全局对象读取私有 Runtime API。

```ts
interface MessageBridgeRuntimeApi {
  getMessageBridgeStatus(): MessageBridgeStatusSnapshot;
  subscribeMessageBridgeStatus(
    listener: (snapshot: MessageBridgeStatusSnapshot) => void,
  ): () => void;
  startMessageBridgeRuntime(): Promise<void>;
  stopMessageBridgeRuntime(): void;
}
```

最小调用示例：

```ts
const runtimeApi = globalThis.__MB_RUNTIME_API__;

await runtimeApi.startMessageBridgeRuntime();
const snapshot = runtimeApi.getMessageBridgeStatus();
```

推荐调用顺序：

1. 先调用 `MessageBridgePlugin(input)` 完成插件加载。
2. 需要展示当前状态时，调用 `getMessageBridgeStatus()` 或 `subscribeMessageBridgeStatus()`。
3. 需要显式恢复或重新启动时，调用 `startMessageBridgeRuntime()`。
4. 需要显式停止时，调用 `stopMessageBridgeRuntime()`。

注意事项：

- `startMessageBridgeRuntime()` 只能在插件已加载后调用。
- `stopMessageBridgeRuntime()` 可在任意时机幂等调用。
- 旧的 private API named export 不再是受支持的访问方式，避免宿主 loader 枚举模块导出时误将私有函数当作插件入口执行。

## API Reference

### `startMessageBridgeRuntime()`

```ts
function startMessageBridgeRuntime(): Promise<void>;
```

用途：

- 使用插件最近一次加载时提供的上下文显式启动或重启 runtime。

调用语义：

- 无参接口。
- 若插件尚未加载过，则 Promise reject。
- 每次显式调用都视为新的启动请求。
- 若当前 runtime 已在运行或仍在启动，本次调用会先终止上一轮生命周期，再启动新一轮 runtime。
- Promise resolve 表示本次启动请求已将 runtime 带到 `ready`。
- Promise reject 表示本次启动请求未能进入 `ready`。

失败处理：

- 对外 reject 的错误必须带可读 `message`。
- reject error 只用于即时失败提示，不作为稳定分类模型。
- 调用方需要稳定失败分类或展示当前失败状态时，应读取 `getMessageBridgeStatus()`。
- 启动成功后，后续连接状态变化仍应通过 `subscribeMessageBridgeStatus()` 观察。

### `stopMessageBridgeRuntime()`

```ts
function stopMessageBridgeRuntime(): void;
```

用途：

- 显式停止当前 runtime。

调用语义：

- 同步 stop。
- 若当前存在连接或启动流程，会被立即停止。
- 无 runtime 时允许幂等调用。
- 调用后状态重置为默认 `not_ready`。
- 调用后插件不会自动恢复 runtime；只有再次显式调用 `startMessageBridgeRuntime()` 才能恢复。

### `getMessageBridgeStatus()`

```ts
function getMessageBridgeStatus(): MessageBridgeStatusSnapshot;
```

用途：

- 读取当前最新完整状态快照。

调用语义：

- 不抛异常。
- 返回快照副本。
- `startMessageBridgeRuntime()` 失败后，调用方应优先通过该接口判断稳定失败类别。

### `subscribeMessageBridgeStatus(listener)`

```ts
function subscribeMessageBridgeStatus(
  listener: (snapshot: MessageBridgeStatusSnapshot) => void,
): () => void;
```

用途：

- 订阅 runtime 状态的语义变化。

调用语义：

- 监听器接收当前完整快照。
- 返回取消订阅函数。
- 订阅只接收语义变化后的快照。
- 若仅 `updatedAt` 变化、其余语义字段不变，则不重复通知。
- 监听器抛错不会中断其他监听器。

## 状态快照

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

字段语义：

| 字段 | 类型 | 说明 |
|---|---|---|
| `connected` | `boolean` | 当前是否已进入 bridge 对外可用的 ready 态 |
| `phase` | `connecting \| ready \| unavailable` | 公开连接阶段 |
| `unavailableReason` | `MessageBridgeUnavailableReason \| null` | 仅 `phase='unavailable'` 时存在 |
| `willReconnect` | `boolean \| null` | `connecting` 时为 `true`，`ready` 时为 `null`，`unavailable` 时为 `false` |
| `lastError` | `string \| null` | 最近一次不可用原因对应的公开错误文本 |
| `updatedAt` | `number` | 当前快照发布时间戳，单位毫秒 |
| `lastReadyAt` | `number \| null` | 最近一次进入 `ready` 的时间戳 |

状态组合约束：

| `phase` | `connected` | `unavailableReason` | `willReconnect` |
|---|---|---|---|
| `ready` | `true` | `null` | `null` |
| `connecting` | `false` | `null` | `true` |
| `unavailable` | `false` | 非空 | `false` |

推荐展示方式：

- 判断 bridge 是否可用时优先使用 `connected`。
- 展示当前阶段时使用 `phase`。
- 展示稳定失败分类时使用 `unavailableReason`。
- 展示即时错误文本时使用 `lastError`。

## 失败处理建议

`startMessageBridgeRuntime()` 的 reject error 只用于即时提示。调用方需要稳定分类时，应读取状态快照中的 `phase`、`unavailableReason` 和 `lastError`。

不可用原因语义：

| 值 | 说明 |
|---|---|
| `not_ready` | 默认初始态或显式 reset 后的基线态 |
| `disabled` | 当前配置禁用了 runtime；`startMessageBridgeRuntime()` 会 reject，hooks 保持可调用但不转发事件 |
| `config_invalid` | 配置加载或校验失败 |
| `plugin_failure` | 进入稳定连接生命周期前的非配置类内部失败 |
| `server_failure` | 服务端拒绝、握手拒绝或明确服务端失败 |
| `network_failure` | transport 超时、socket 错误、异常 close、连接失败 |

补充规则：

- `not_ready` 只用于默认初始态和显式 reset 后。
- 运行中失败不会回落为 `not_ready`。
- `server_failure` 优先级高于后续 `network_failure`。

## 生命周期语义

`MessageBridgePlugin(input)` 仍是宿主标准加载入口。对宿主可依赖的行为如下：

- 插件加载时会尝试一次自动启动。
- 若当前 runtime 已在运行或仍在启动，再次加载不会额外创建第二个 runtime。
- 插件加载失败后，后续仍可通过 `startMessageBridgeRuntime()` 显式恢复。
- 插件加载返回的 hooks 在插件生命周期内保持稳定。
- 当 runtime 未启动或不可用时，hooks 收到的事件会被忽略。
- 当 runtime 正在启动但尚未进入 `ready` 时，hooks 收到的事件也会被忽略。
- hooks 不会因为收到事件而隐式启动 runtime。
- 当后续显式 `startMessageBridgeRuntime()` 成功后，同一份 hooks 会恢复事件转发能力。
- `stopMessageBridgeRuntime()` 调用后，插件不会自动恢复；如需恢复，必须再次显式调用 `startMessageBridgeRuntime()`。

## 调用方检查清单

- [ ] 通过 `globalThis.__MB_RUNTIME_API__` 获取私有 Runtime API。
- [ ] 不依赖 private API named export。
- [ ] 在调用 `startMessageBridgeRuntime()` 前，已至少完成一次 `MessageBridgePlugin(input)` 加载。
- [ ] 将 `startMessageBridgeRuntime()` 的 reject error 仅用于即时提示。
- [ ] 使用 `getMessageBridgeStatus()` 或 `subscribeMessageBridgeStatus()` 读取稳定状态。
- [ ] 使用 `unavailableReason` 做失败分类，使用 `lastError` 做用户可见错误文本。
- [ ] 显式 stop 后，如需恢复，重新调用 `startMessageBridgeRuntime()`。
