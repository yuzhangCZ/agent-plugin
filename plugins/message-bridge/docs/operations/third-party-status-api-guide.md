# 三方应用私有状态 API 接入指南

**Version:** 1.0  
**Date:** 2026-04-01  
**Status:** Active  
**Owner:** message-bridge maintainers  
**Related:** `../README.md`, `../design/interfaces/private-status-api-contract.md`, `./opencode-integration-guide.md`

面向通过 npm 包或本地工作区包集成 `message-bridge` 的三方应用，说明如何在宿主进程内读取插件连接状态，并把状态展示到 UI 中。

## 1. In Scope

- 说明 `getMessageBridgeStatus()` 和 `subscribeMessageBridgeStatus()` 的使用方式
- 说明三方应用在 UI 中如何解释 `phase`、`unavailableReason`、`willReconnect`
- 说明接入时机、订阅释放和常见展示策略

## 2. Out of Scope

- 不修改 `status_query` / `status_response` 协议
- 不定义跨插件共享的宿主状态中心
- 不定义跨进程、远程查询或持久化状态能力
- 不改 gateway 服务端断连与重连策略

## 3. External Dependencies

- 宿主应用与 `message-bridge` 必须运行在同一进程
- OpenCode 必须已经按既有方式完成插件加载
- 状态是否自动恢复，依赖 runtime 当前重连策略和服务端行为

## 4. 适用前提

只有满足以下条件时，才应使用这套私有状态 API：

- 你的应用直接集成了 `message-bridge`
- 宿主应用与插件运行在同一 Node.js 进程
- 你需要在宿主 UI 中显示 bridge 当前连接状态

以下场景不适用：

- 需要跨进程读取 bridge 状态
- 需要通过网络接口查询 bridge 状态
- 需要为多个插件设计统一宿主状态中心
- 仅让 OpenCode 通过本地插件目录加载插件，但宿主工程本身没有把插件包接入当前依赖图

## 4.1 包入口要求

宿主侧读取状态 API 时，必须通过插件**包入口**导入：

```js
import {
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from '@wecode/skill-opencode-plugin';
```

这条约束同时适用于：

- 通过 npm 私仓安装插件包
- 在 monorepo 中把 `plugins/message-bridge` 作为本地工作区包接入

不推荐也不保证兼容以下做法：

- 直接 import `plugins/message-bridge/src/**`
- 直接 import `release/**`
- 依赖未公开的运行时内部文件路径

如果你的场景只是让 OpenCode 通过 `file:///absolute/path/to/plugins/message-bridge` 加载插件，但宿主工程没有把该包接入自己的依赖图，那么宿主侧**不能直接使用**这套私有状态 API。

## 4.2 本地工作区包接入示例

如果三方应用和 `message-bridge` 位于同一 monorepo，推荐把插件作为工作区包接入，再统一从包入口读取状态 API。

示例：

```json
{
  "dependencies": {
    "@wecode/skill-opencode-plugin": "workspace:*"
  }
}
```

然后继续使用包入口导入：

```js
import {
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from '@wecode/skill-opencode-plugin';
```

## 5. API 导出

```ts
function getMessageBridgeStatus(): MessageBridgeStatusSnapshot;

function subscribeMessageBridgeStatus(
  listener: (snapshot: MessageBridgeStatusSnapshot) => void,
): () => void;
```

接入方式：

```js
import {
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from '@wecode/skill-opencode-plugin';
```

说明：

- `getMessageBridgeStatus()` 用于读取当前最新状态快照
- `subscribeMessageBridgeStatus()` 用于监听后续状态变化
- 返回的取消订阅函数必须在页面卸载或宿主销毁时调用

## 6. 状态模型

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

字段解释：

| 字段 | 说明 | UI 是否建议直接使用 |
|---|---|---|
| `connected` | 当前是否已经进入 `READY` | 是 |
| `phase` | 主状态分类：连接中、已连接、不可用 | 是 |
| `unavailableReason` | 不可用原因 | 是，用于提示文案 |
| `willReconnect` | 当前是否会自动恢复 | 是，用于提示文案 |
| `lastError` | 最近一次错误文本 | 可选 |
| `updatedAt` | 状态最后更新时间 | 可选 |
| `lastReadyAt` | 最近一次成功连接时间 | 可选 |

## 7. 最小接入示例

```js
import {
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from '@wecode/skill-opencode-plugin';

function renderBridgeStatus(snapshot) {
  if (snapshot.phase === 'ready') {
    return '已连接';
  }

  if (snapshot.phase === 'connecting') {
    return '连接中';
  }

  return '不可用';
}

const initialSnapshot = getMessageBridgeStatus();
console.log(renderBridgeStatus(initialSnapshot));

const unsubscribe = subscribeMessageBridgeStatus((snapshot) => {
  console.log(renderBridgeStatus(snapshot));
});

process.on('exit', () => {
  unsubscribe();
});
```

## 8. React 接入示例

```tsx
import { useEffect, useState } from 'react';
import {
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from '@wecode/skill-opencode-plugin';

export function BridgeStatusBadge() {
  const [snapshot, setSnapshot] = useState(() => getMessageBridgeStatus());

  useEffect(() => {
    return subscribeMessageBridgeStatus(setSnapshot);
  }, []);

  if (snapshot.phase === 'ready') {
    return <span>已连接</span>;
  }

  if (snapshot.phase === 'connecting') {
    return <span>连接中</span>;
  }

  if (
    snapshot.unavailableReason === 'server_disconnected' &&
    snapshot.willReconnect === false
  ) {
    return <span>服务端已断开连接，当前不会自动重连</span>;
  }

  return <span>不可用</span>;
}
```

## 9. 推荐展示策略

| 条件 | 推荐文案 |
|---|---|
| `phase='ready'` | 已连接 |
| `phase='connecting'` | 连接中 |
| `phase='unavailable'` 且 `unavailableReason='uninitialized'` | 插件未初始化 |
| `phase='unavailable'` 且 `unavailableReason='disabled'` | 插件已禁用 |
| `phase='unavailable'` 且 `unavailableReason='config_invalid'` | 配置无效 |
| `phase='unavailable'` 且 `unavailableReason='register_rejected'` | 鉴权失败或注册被拒绝 |
| `phase='unavailable'` 且 `unavailableReason='server_disconnected'` 且 `willReconnect=false` | 服务端已断开连接，当前不会自动重连 |
| `phase='unavailable'` 且 `unavailableReason='disconnected'` | 连接已断开 |

推荐原则：

- 先使用 `phase` 判断主状态
- 再用 `unavailableReason` 和 `willReconnect` 细化提示
- `lastError` 适合作为 tooltip、诊断信息或开发者日志，不建议直接替代主文案

## 10. 接入时机与释放时机

推荐接入时机：

- OpenCode 完成启动后立即读取一次 `getMessageBridgeStatus()`
- 在宿主 UI 状态容器、页面组件或桌面端状态管理层建立订阅

推荐释放时机：

- React 组件卸载时
- 宿主销毁或退出时
- 你明确不再展示 bridge 状态时

如果不释放订阅，监听器会继续保留在当前进程内。

## 11. 常见误用

- 不要通过 `status_query -> status_response` 读取 bridge 连接状态
- 不要把这套私有 API 误当作跨插件通用宿主接口
- 不要在跨进程场景中直接依赖这套 API
- 不要把 `connected=true` 的判定放宽为 WebSocket `open`

唯一正确的“已连接”判定是：**runtime 已进入 `READY`。**

## 12. 排障建议

当 UI 长时间停留在 `unavailable` 时，优先检查：

- 插件是否已被 OpenCode 正常加载
- `BRIDGE_AUTH_AK`、`BRIDGE_AUTH_SK`、`BRIDGE_GATEWAY_CHANNEL` 是否正确
- 是否出现 `register_rejected`
- gateway 是否主动关闭连接且当前不再重连

更详细的运行日志排查方式，见 [OpenCode 集成指导](./opencode-integration-guide.md)。
