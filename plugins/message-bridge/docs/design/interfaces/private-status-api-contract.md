# 私有状态 API 契约

**Version:** 1.2  
**Date:** 2026-04-03  
**Status:** Active  
**Owner:** message-bridge maintainers  
**Related:** `../../product/prd.md`, `../../architecture/overview.md`, `./protocol-contract.md`, `../../operations/opencode-integration-guide.md`

## 1. 背景

`message-bridge` 当前补充了一套**插件私有**连接状态 API，供与 OpenCode 同进程集成的宿主读取插件连接状态，并在 UI 中提示“连接中 / 已连接 / 不可用”。

该接口有两个边界必须保持稳定：

1. 它不属于 `ai-gateway` 外部协议，不替代 `status_query -> status_response`
2. 它不定义宿主通用能力，只描述 `message-bridge` 当前实现暴露的私有读取面

因此，本文件描述的是**插件进程内私有接口契约**，不是 gateway 协议契约。

## 2. In Scope

- 定义 `message-bridge` 私有状态 API 的导出函数
- 定义状态快照字段、默认值与不变量
- 定义 runtime 内部状态到状态快照的映射语义
- 定义集成方读取该状态 API 的使用方式

## 3. Out of Scope

- 不修改 `status_query` / `status_response` 的协议语义
- 不定义跨插件共享的宿主状态中心
- 不定义跨进程共享、持久化或远程查询状态的机制
- 不改服务端业务逻辑或 gateway 关闭连接的判定规则

## 4. External Dependencies

- OpenCode 与 `message-bridge` 必须运行在同一进程，宿主才能直接读取该 API
- gateway 是否重连、何时断开，仍由现有连接层与服务端行为共同决定
- 幂等与一致性仍由服务端负责；本 API 只反映本地 runtime 当前观测到的状态

## 5. 对外导出

当前插件模块新增以下命名导出：

```ts
function getMessageBridgeStatus(): MessageBridgeStatusSnapshot;

function subscribeMessageBridgeStatus(
  listener: (snapshot: MessageBridgeStatusSnapshot) => void,
): () => void;
```

说明：

- `getMessageBridgeStatus()` 返回当前最新快照，不抛异常
- `subscribeMessageBridgeStatus()` 返回取消订阅函数
- 若状态语义没有变化，订阅者不会收到重复通知
- 对于一次建链失败或一次连接关闭，状态发布会尽量收敛为一次最终可消费的状态变化，不对外暴露仅用于内部拼装原因的临时中间态
- 这两个接口的调用与状态变化会输出 `status_api.*` 日志，便于宿主排障

## 6. 状态模型

### 6.1 类型定义

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

### 6.2 字段说明

| 字段 | 类型 | 默认值 | 可配置 | 说明 |
|---|---|---|---|---|
| `connected` | `boolean` | `false` | 否 | 当前是否已经完成 gateway `READY` |
| `phase` | `'connecting' \| 'ready' \| 'unavailable'` | `'unavailable'` | 否 | 对 UI 暴露的主状态分类 |
| `unavailableReason` | `MessageBridgeUnavailableReason \| null` | `'not_ready'` | 否 | 当前不可用时的原因；非 `unavailable` 状态为 `null` |
| `willReconnect` | `boolean \| null` | `false` | 否 | 当前状态下是否会自动恢复；`ready` 为 `null` |
| `lastError` | `string \| null` | `null` | 否 | 最近一次可诊断错误文案 |
| `updatedAt` | `number` | `Date.now()` | 否 | 最近一次语义变化时间戳，单位毫秒 |
| `lastReadyAt` | `number \| null` | `null` | 否 | 最近一次进入 `ready` 的时间戳，单位毫秒 |

### 6.3 状态不变量

- `phase='ready'` 时：
  - `connected=true`
  - `unavailableReason=null`
  - `willReconnect=null`
- `phase='connecting'` 时：
  - `connected=false`
  - `unavailableReason=null`
  - `willReconnect=true`
- `phase='unavailable'` 时：
  - `connected=false`
  - `unavailableReason!=null`
  - `willReconnect=false`

连接成功的唯一判定为：**gateway 进入 `READY`，即收到 `register_ok`**。

## 7. 状态映射规则

| 运行时场景 | `phase` | `unavailableReason` | `willReconnect` | 说明 |
|---|---|---|---|---|
| runtime 尚未创建 | `unavailable` | `not_ready` | `false` | 默认初始态 |
| 配置显式禁用 | `unavailable` | `disabled` | `false` | `enabled=false` |
| 配置解析或校验失败 | `unavailable` | `config_invalid` | `false` | 启动前失败 |
| 首次连接或自动重连中 | `connecting` | `null` | `true` | 尚未进入 `READY` |
| 收到 `register_ok` | `ready` | `null` | `null` | 唯一可视为已连接的状态 |
| 运行中断连且不会重连 | `unavailable` | `network_failure` 或 `server_failure` | `false` | 直接发布最终不可用状态；取决于是否存在明确拒绝证据 |
| register 被拒绝 | `unavailable` | `server_failure` | `false` | `register_rejected` 场景 |
| 启动流程抛错 | `unavailable` | `plugin_failure` | `false` | runtime 启动失败 |

关闭路径补充约束：

- 当连接关闭后 runtime 仍会自动重连时，订阅方应直接收到 `connecting`
- 当连接关闭后 runtime 明确不会自动重连时，订阅方应直接收到最终 `unavailable`
- 连接关闭链路不应先对外发布一个临时 `network_failure`，再补发 `connecting` 或 `server_failure`

## 8. 为什么需要 `willReconnect`

如果只保留 `unavailableReason`，则下面两类状态无法稳定区分：

- 当前已经断开，但 runtime 仍会自动重连
- 当前已经断开，且 runtime 明确不会重连

若把这两层语义都压进 `reason`，枚举会膨胀成：

- `network_failure_reconnecting`
- `server_failure_no_reconnect`
- `server_rejected_no_reconnect`

这会让一个字段同时承担“原因”和“后续动作”两个职责。  
当前实现将其拆分为：

- `unavailableReason`：为什么不可用
- `willReconnect`：后续是否自动恢复

## 9. 服务端主动断开示例

当出现“服务端主动断开，且当前不会重连”时，状态快照应为：

```json
{
  "connected": false,
  "phase": "unavailable",
  "unavailableReason": "server_failure",
  "willReconnect": false,
  "lastError": "gateway closed the connection",
  "updatedAt": 1711814400000,
  "lastReadyAt": 1711814300000
}
```

如果运行时判断当前断连后会自动恢复，则状态应为：

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

## 10. 与 `status_query` 的关系

两者的职责完全不同：

| 能力 | 作用域 | 读取方式 | 主要用途 |
|---|---|---|---|
| `status_query -> status_response` | gateway 外部协议 | 远端报文交互 | 查询 OpenCode 在线状态 |
| 私有状态 API | 插件进程内私有接口 | 本地函数调用与订阅 | 查询 bridge 连接状态并驱动宿主 UI |

兼容约束：

- `status_response` 仍只承诺 `opencodeOnline:boolean`
- 私有状态 API 不得向 gateway 透出 `unavailableReason`、`willReconnect` 等字段

## 11. 集成示例

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

// 需要停止监听时调用
unsubscribe();
```

使用约束：

- 仅适用于与插件运行在同一进程内的集成方式
- 不应把该私有 API 误当作跨插件通用接口
- 若需要跨进程或跨宿主统一状态接口，应单独立项设计
