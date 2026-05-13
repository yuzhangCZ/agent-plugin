# 私有 Runtime API 契约

**Version:** 1.1
**Date:** 2026-05-11
**Status:** Active
**Owner:** message-bridge maintainers
**Related:** `./protocol-contract.md`, `../../product/prd.md`, `../../architecture/overview.md`, `../../../../../docs/design/qrcode-auth-session-solution.md`, `../../../../../docs/design/qrcode-auth-exposure-solution.md`

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

私有 Runtime API 面向同进程宿主调用方，用于控制 `message-bridge` runtime 的启动、停止，并读取或订阅 runtime 状态；同一宿主对象也承载与 bridge 直接相关的其他私有能力入口。

这组接口分成两类：

- 控制接口：启动或停止 runtime
- 状态接口：读取当前状态或订阅状态变化

本文重点定义 runtime/status 能力的语义边界；对于同一对象上挂载的二维码授权能力，本文同时提供面向业务接入的 API 定义摘要，方便宿主侧按统一入口接入。二维码授权能力的包级类型真源仍以 `packages/skill-qrcode-auth/src/types.ts` 与相关设计文档为准；当本文摘要与能力真源发生冲突时，以能力真源为准。

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
  qrcodeAuth: QrCodeAuth;
}
```

最小调用示例：

```ts
const runtimeApi = globalThis.__MB_RUNTIME_API__;

await runtimeApi.qrcodeAuth.run(input);
await runtimeApi.startMessageBridgeRuntime();
const snapshot = runtimeApi.getMessageBridgeStatus();
```

推荐调用顺序：

1. 先调用 `MessageBridgePlugin(input)` 完成插件加载。
2. 再读取 `globalThis.__MB_RUNTIME_API__` 并按需调用其中能力。
3. 需要展示当前状态时，调用 `getMessageBridgeStatus()` 或 `subscribeMessageBridgeStatus()`。
4. 需要显式恢复或重新启动时，调用 `startMessageBridgeRuntime()`。
5. 需要显式停止时，调用 `stopMessageBridgeRuntime()`。

注意事项：

- `startMessageBridgeRuntime()` 只能在插件已加载后调用。
- `qrcodeAuth` 也只能在插件已加载、宿主对象已注册后读取；插件未加载前不保证 `globalThis.__MB_RUNTIME_API__` 存在。
- `qrcodeAuth.run()` 不依赖 runtime 已启动；其领域语义以二维码授权设计文档为准。
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

### `qrcodeAuth.run(input)`

```ts
interface QrCodeAuth {
  run(input: QrCodeAuthRunInput): Promise<void>;
}
```

用途：

- 通过宿主私有 Runtime API 发起一次独立的二维码授权会话。

入参：

```ts
interface QrCodeAuthRunInput {
  environment?: "uat" | "prod";
  channel: string;
  mac: string;
  policy?: {
    refreshOnExpired?: boolean;
    maxRefreshCount?: number;
    pollIntervalMs?: number;
  };
  onSnapshot: (snapshot: QrCodeAuthSnapshot) => void;
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `environment` | `"uat" \| "prod"` | 否 | `prod` | 授权环境；未传时默认 `prod` |
| `channel` | `string` | 是 | 无 | 宿主桥接通道标识；需为非空字符串 |
| `mac` | `string` | 是 | 无 | 设备 MAC；当前 OpenCode 宿主接入层可自动采集，失败时传 `""` |
| `policy.refreshOnExpired` | `boolean` | 否 | `true` | 二维码过期后是否自动刷新 |
| `policy.maxRefreshCount` | `number` | 否 | `3` | 自动刷新最大次数；要求 `>= 0` |
| `policy.pollIntervalMs` | `number` | 否 | `2000` | 轮询间隔，单位毫秒；要求 `> 0` |
| `onSnapshot` | `(snapshot: QrCodeAuthSnapshot) => void` | 是 | 无 | 唯一业务事件输出通道 |

出参：

| 项目 | 类型 | 说明 |
|---|---|---|
| 返回值 | `Promise<void>` | 只表示本次授权流程结束，不直接返回 `ak/sk` 等业务结果 |
| 业务结果出口 | `input.onSnapshot` | 授权过程中的二维码展示、扫码、确认、失败等事件均通过回调输出 |

事件模型：

```ts
type QrCodeAuthSnapshot =
  | {
      type: "qrcode_generated";
      qrcode: string;
      display: QrCodeDisplayData;
      expiresAt: string;
    }
  | {
      type: "scanned";
      qrcode: string;
    }
  | {
      type: "expired";
      qrcode: string;
    }
  | {
      type: "cancelled";
      qrcode: string;
    }
  | {
      type: "confirmed";
      qrcode: string;
      credentials: {
        ak: string;
        sk: string;
      };
    }
  | {
      type: "failed";
      qrcode?: string;
      reasonCode: "timeout" | "network_error" | "auth_service_error";
      serviceError?: QrCodeAuthServiceError;
    };
```

以上代码块与下表用于提供业务接入所需的接口摘要；类型真源仍以 `packages/skill-qrcode-auth/src/types.ts` 为准。

| `type` | 是否终态 | 额外字段 | 说明 |
|---|---|---|---|
| `qrcode_generated` | 否 | `qrcode` `display` `expiresAt` | 新二维码已生成，可用于展示扫码入口 |
| `scanned` | 否 | `qrcode` | 当前二维码已扫码，等待用户确认 |
| `expired` | 否 | `qrcode` | 当前二维码已过期；若策略允许，运行时可继续刷新下一张二维码 |
| `cancelled` | 是 | `qrcode` | 用户取消授权，本次会话结束 |
| `confirmed` | 是 | `qrcode` `credentials` | 用户确认授权成功，`credentials` 内返回 `ak/sk` |
| `failed` | 是 | `qrcode?` `reasonCode` `serviceError?` | 授权流程失败；失败分类与服务错误信息通过字段输出 |

字段补充说明：

| 字段 | 类型 | 出现场景 | 说明 |
|---|---|---|---|
| `qrcode` | `string` | `qrcode_generated` `scanned` `expired` `cancelled` `confirmed`，`failed` 中可选 | 当前二维码实例的事件级关联键；`failed` 发生在二维码创建前时可能缺失 |
| `display.qrcode` | `string` | `qrcode_generated` | 二维码唯一标识；在 `qrcode_generated` 事件中与顶层 `qrcode` 表示同一二维码，业务侧应统一使用顶层 `qrcode` 作为跨事件关联键 |
| `display.weUrl` | `string` | `qrcode_generated` | H5 扫码内容，通常作为主展示入口 |
| `display.pcUrl` | `string` | `qrcode_generated` | PC 端辅助拉起链接 |
| `expiresAt` | `string` | `qrcode_generated` | 当前二维码过期时间 |
| `credentials.ak` | `string` | `confirmed` | 授权成功后返回的访问凭据 AK |
| `credentials.sk` | `string` | `confirmed` | 授权成功后返回的访问凭据 SK |
| `reasonCode` | `"timeout" \| "network_error" \| "auth_service_error"` | `failed` | 稳定失败分类 |
| `serviceError` | `QrCodeAuthServiceError` | `failed` | 服务端错误的安全子集，可能为空 |

调用语义：

- 调用前必须已经完成一次 `MessageBridgePlugin(input)` 加载，并从 `globalThis.__MB_RUNTIME_API__` 读取宿主对象。
- `qrcodeAuth.run()` 不依赖 runtime 已启动；只要插件已加载、宿主对象已注册，即可独立调用。
- `qrcodeAuth.run()` 返回 `Promise<void>`，只表示本次授权流程结束，不返回业务结果。
- 授权过程中的业务事件仍只通过 `input.onSnapshot` 输出。
- `qrcodeAuth.run()` 的输入字段、事件模型、默认值与终态规则，以二维码授权设计文档和能力真源包为准。

宿主接入约束：

- 插件未加载前，不保证 `globalThis.__MB_RUNTIME_API__` 存在，也不保证 `qrcodeAuth` 属性可读取。
- 当前 OpenCode 宿主接入策略可以在进入 `qrcodeAuth.run()` 前预填 `channel = "openx"`，并自动采集 `mac`；采集失败时传空字符串 `""`。
- 上述默认值策略属于宿主接入层约束，不属于 `qrcodeAuth.run()` 作为低层 facade 的公共语义。

失败处理：

- 插件未加载导致的宿主对象不存在，属于宿主读取前置条件未满足，不属于 `qrcodeAuth.run()` 的业务失败模型。
- `qrcodeAuth.run()` 会同步校验输入；例如 `channel` 为空、`mac` 不是字符串、`onSnapshot` 不是函数、或 `policy` 数值非法时，会抛出 `TypeError`。
- `qrcodeAuth.run()` 进入授权流程后的失败分类、终态事件与服务错误语义，以二维码授权设计文档为准。

接入示例：

```ts
const runtimeApi = globalThis.__MB_RUNTIME_API__;

await runtimeApi.qrcodeAuth.run({
  environment: "prod",
  channel: "openx",
  mac: resolvedMacAddress,
  policy: {
    refreshOnExpired: true,
    maxRefreshCount: 3,
    pollIntervalMs: 2000,
  },
  onSnapshot(snapshot) {
    switch (snapshot.type) {
      case "qrcode_generated":
        renderQrCode(snapshot.display.weUrl);
        return;
      case "scanned":
        showPendingConfirmation();
        return;
      case "expired":
        showQrCodeExpired(snapshot.qrcode);
        return;
      case "cancelled":
        showAuthCancelled(snapshot.qrcode);
        return;
      case "confirmed":
        saveCredentials(snapshot.credentials.ak, snapshot.credentials.sk);
        return;
      case "failed":
        showAuthFailure(snapshot.reasonCode, snapshot.serviceError);
        return;
      default:
        assertNever(snapshot);
    }
  },
});
```

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
- [ ] 在读取 `qrcodeAuth` 前，已至少完成一次 `MessageBridgePlugin(input)` 加载。
- [ ] 将 `startMessageBridgeRuntime()` 的 reject error 仅用于即时提示。
- [ ] 使用 `getMessageBridgeStatus()` 或 `subscribeMessageBridgeStatus()` 读取稳定状态。
- [ ] 使用 `unavailableReason` 做失败分类，使用 `lastError` 做用户可见错误文本。
- [ ] 显式 stop 后，如需恢复，重新调用 `startMessageBridgeRuntime()`。
