# 三方应用私有状态 API 接口说明

**Version:** 1.3  
**Date:** 2026-04-03  
**Status:** Active  
**Owner:** message-bridge maintainers  
**Related:** `../README.md`, `../design/interfaces/private-status-api-contract.md`, `./opencode-integration-guide.md`

本文档只说明 `message-bridge` 对外提供的私有状态 API，以及这些接口返回字段的含义。它不是宿主接入手册，也不覆盖 UI 设计、框架用法或宿主工程组织方式。

## 1. In Scope

- 说明 `getMessageBridgeStatus()` 和 `subscribeMessageBridgeStatus()` 的导出方式
- 说明 `MessageBridgeStatusSnapshot` 的字段语义
- 说明这套私有状态 API 的适用边界

## 2. Out of Scope

- 不修改 `status_query` / `status_response` 协议
- 不定义跨插件共享的宿主状态中心
- 不定义跨进程、远程查询或持久化状态能力
- 不提供宿主集成流程、UI 展示策略或框架示例

## 3. External Dependencies

- 宿主应用与 `message-bridge` 必须运行在同一进程
- 状态只反映当前 runtime 的本地观测结果
- gateway 是否重连、何时断开，仍由现有连接层与服务端行为决定

## 4. API 导出

应通过插件包入口导入：

```js
import {
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from '@wecode/skill-opencode-plugin';
```

```ts
function getMessageBridgeStatus(): MessageBridgeStatusSnapshot;

function subscribeMessageBridgeStatus(
  listener: (snapshot: MessageBridgeStatusSnapshot) => void,
): () => void;
```

接口说明：

- `getMessageBridgeStatus()` 返回当前最新状态快照，不抛异常
- `subscribeMessageBridgeStatus()` 用于订阅状态变化，返回取消订阅函数
- 若状态语义没有变化，订阅者不会收到重复通知
- 对于一次连接关闭或一次建链失败，插件会尽量直接发布最终状态；不会先发一个临时 `unavailable` 中间态，再补发最终原因
- 这两个接口的调用与状态变化会输出 `status_api.*` 日志，便于宿主排障

## 5. 状态模型

```ts
type MessageBridgePhase = 'connecting' | 'ready' | 'unavailable';

type MessageBridgeUnavailableReason =
  | 'not_ready'
  | 'disabled'
  | 'config_invalid'
  | 'plugin_failure'
  | 'server_failure'
  | 'network_failure';

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

字段说明：

| 字段 | 类型 | 取值 | 说明 |
|---|---|---|---|
| `connected` | `boolean` | `true` / `false` | 是否已连接成功；仅当 `phase='ready'` 时为 `true` |
| `phase` | `MessageBridgePhase` | `'connecting'` / `'ready'` / `'unavailable'` | 对外暴露的主状态分类，用于区分连接中、已连接和不可用 |
| `unavailableReason` | `MessageBridgeUnavailableReason \| null` | `'not_ready'` / `'disabled'` / `'config_invalid'` / `'plugin_failure'` / `'server_failure'` / `'network_failure'` / `null` | 当前不可用时的原因；非 `unavailable` 状态为 `null` |
| `willReconnect` | `boolean \| null` | `true` / `false` / `null` | 当前状态下是否会自动恢复；`ready` 时为 `null` |
| `lastError` | `string \| null` | 错误文本或 `null` | 最近一次可诊断错误文本 |
| `updatedAt` | `number` | 毫秒时间戳 | 最近一次状态语义变化时间戳，单位毫秒 |
| `lastReadyAt` | `number \| null` | 毫秒时间戳或 `null` | 最近一次进入 `ready` 的时间戳，单位毫秒 |

状态语义：

- `phase='ready'`：表示 runtime 已进入 `READY`
- `phase='connecting'`：表示首次连接或自动重连中
- `phase='unavailable'`：表示当前不可用，需结合 `unavailableReason` 判断原因
- 若连接关闭后 runtime 会自动恢复，订阅方应直接收到 `connecting`
- 若连接关闭后 runtime 不会自动恢复，订阅方应直接收到最终 `unavailable` 状态，并带上最终原因

## 6. 最小使用示例

```js
import {
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from '@wecode/skill-opencode-plugin';

const initialSnapshot = getMessageBridgeStatus();
console.log(initialSnapshot.phase);

const unsubscribe = subscribeMessageBridgeStatus((snapshot) => {
  console.log(snapshot.phase, snapshot.unavailableReason, snapshot.willReconnect);
});

unsubscribe();
```

## 7. 注意事项

- 不要通过 `status_query -> status_response` 读取 bridge 连接状态
- 不要把这套私有 API 误当作跨插件通用宿主接口
- 不要在跨进程场景中直接依赖这套 API
- 不要把 `connected=true` 的判定放宽为 WebSocket `open`
