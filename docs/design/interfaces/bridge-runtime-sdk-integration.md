# bridge-runtime-sdk 对外集成文档

**Version:** 1.0  
**Date:** 2026-05-19  
**Status:** Active  
**Owner:** agent-plugin maintainers  
**Related:** `@wecode/bridge-runtime-sdk` stable public contract

## 1. 文档定位

本文面向 `@wecode/bridge-runtime-sdk` 集成方，说明如何实现 `ThirdPartyAgentProvider` 并接入 Runtime。

本文只描述以下稳定契约：

- 根入口导出能力
- Runtime 与 Provider 的接口调用方式
- 主要入参、出参和字段语义
- 文本流、事实流、错误语义
- 最小合法接入方式

本文不覆盖以下内容：

- SDK 内部实现、内部组件或内部状态流转
- 消费侧展示逻辑或事件映射逻辑
- 仓库内部代码组织、测试缝或源码定位方式

## 2. 稳定导出概览

`@wecode/bridge-runtime-sdk` 根入口稳定导出 3 类能力：

- Runtime API：`createBridgeRuntime`、`BridgeRuntime`
- Provider 集成契约：`ThirdPartyAgentProvider` 及相关类型
- 二维码授权能力：`qrcodeAuth`

接入方统一从 `@wecode/bridge-runtime-sdk` 导入运行时 API、Provider 契约和二维码授权能力即可。

## 3. Runtime API

### 3.1 `createBridgeRuntime(options)`

用于创建 Runtime 实例。

| 项目 | 说明 |
|---|---|
| 接口名 | `createBridgeRuntime` |
| 入参 | `BridgeRuntimeOptions` |
| 出参 | `Promise<BridgeRuntime>` |
| 说明 | 创建 Runtime facade。 |

#### 入参类型：`BridgeRuntimeOptions`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `provider` | `ThirdPartyAgentProvider` | 是 | 集成方实现的 Provider SPI。 |
| `gatewayHost` | `BridgeGatewayHostConfig` | 是 | Gateway 连接与注册配置。 |
| `logger` | `BridgeGatewayLogger` | 否 | 可选日志接口。 |
| `debug` | `boolean` | 否 | 是否打开调试日志。 |
| `traceIdFactory` | `() => string` | 否 | 自定义 traceId 生成器。未提供时由 SDK 生成。 |
| `onTelemetryUpdated` | `() => void` | 否 | 运行时观测信息变更时触发。 |

#### 嵌套类型：`BridgeGatewayHostConfig`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `url` | `string` | 否 | Gateway 地址。未提供时使用 SDK 默认连接配置。 |
| `auth.ak` | `string` | 是 | Gateway 鉴权 AK。 |
| `auth.sk` | `string` | 是 | Gateway 鉴权 SK。 |
| `register.toolType` | `BridgeGatewayToolType` | 是 | 工具注册类型。 |
| `register.toolVersion` | `string` | 是 | 当前宿主 agent 版本。 |
| `register.pluginVersion` | `string` | 否 | 上层插件版本。宿主无插件封装层时可省略。 |

#### 嵌套类型：`BridgeGatewayLogger`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `debug` | `(message: string, meta?: Record<string, unknown>) => void` | 否 | 调试日志输出。 |
| `info` | `(message: string, meta?: Record<string, unknown>) => void` | 否 | 信息日志输出。 |
| `warn` | `(message: string, meta?: Record<string, unknown>) => void` | 否 | 警告日志输出。 |
| `error` | `(message: string, meta?: Record<string, unknown>) => void` | 否 | 错误日志输出。 |
| `child` | `(meta: Record<string, unknown>) => BridgeGatewayLogger` | 否 | 基于上下文派生子 logger。 |
| `getTraceId` | `() => string` | 否 | 为日志补充 traceId。 |

- 该调用只创建实例，不表示已建立可用连接。
- 集成方应在 `await runtime.start()` 成功后，再将 Runtime 视为可处理请求。

```ts
import { createBridgeRuntime } from '@wecode/bridge-runtime-sdk';

const runtime = await createBridgeRuntime({
  provider,
  gatewayHost,
});
```

### 3.2 `runtime.start()`

用于启动 Runtime。

| 项目 | 说明 |
|---|---|
| 接口名 | `BridgeRuntime.start` |
| 入参 | 无 |
| 出参 | `Promise<void>` |
| 说明 | 启动 Runtime 并进入可处理请求状态。 |

- `start()` 成功前，集成方不应将 Runtime 视为已就绪。
- `start()` resolve 表示 Runtime 已完成启动并进入可处理请求状态，而不是仅完成底层建链。
- 启动阶段如发生异常，`start()` 会 reject；调用方应按启动失败处理。

```ts
await runtime.start();
```

### 3.3 `runtime.stop()`

用于停止 Runtime。

| 项目 | 说明 |
|---|---|
| 接口名 | `BridgeRuntime.stop` |
| 入参 | 无 |
| 出参 | `Promise<void>` |
| 说明 | 停止 Runtime。 |

- `stop()` 之后，集成方不得继续使用旧的 `ProviderRuntimeContext`、旧的 `ProviderRun` 或旧的 outbound 发送器。

```ts
await runtime.stop();
```

### 3.4 `runtime.probe(input)`

用于主动探测当前配置。

| 项目 | 说明 |
|---|---|
| 接口名 | `BridgeRuntime.probe` |
| 入参 | `{ timeoutMs: number }` |
| 出参 | `Promise<BridgeGatewayProbeResult>` |
| 说明 | 返回当前网关探测结果。 |

#### 出参类型：`BridgeGatewayProbeResult`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `state` | `'ready' \| 'rejected' \| 'connect_error' \| 'timeout' \| 'connecting' \| 'cancelled'` | 是 | 探测结果状态。 |
| `latencyMs` | `number` | 是 | 本次探测耗时，单位毫秒。 |
| `reason` | `string` | 否 | 探测失败或未完成时的附加说明。 |

```ts
const probe = await runtime.probe({ timeoutMs: 3000 });
```

### 3.5 `runtime.getStatus()`

用于读取当前生命周期状态。

| 项目 | 说明 |
|---|---|
| 接口名 | `BridgeRuntime.getStatus` |
| 入参 | 无 |
| 出参 | `BridgeRuntimeStatusSnapshot` |
| 说明 | 返回当前 Runtime 状态快照。 |

#### 出参类型：`BridgeRuntimeStatusSnapshot`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `state` | `'idle' \| 'starting' \| 'ready' \| 'reconnecting' \| 'stopping' \| 'failed'` | 是 | Runtime 当前状态。 |
| `failureReason` | `string \| null` | 是 | 当前失败原因；无失败时为 `null`。 |

```ts
const status = runtime.getStatus();
```

### 3.6 `runtime.getDiagnostics()`

用于读取当前诊断快照。

| 项目 | 说明 |
|---|---|
| 接口名 | `BridgeRuntime.getDiagnostics` |
| 入参 | 无 |
| 出参 | `RuntimeDiagnostics` |
| 说明 | 返回运行时诊断信息。 |

#### 出参类型：`RuntimeDiagnostics`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `gatewayState` | `string` | 否 | 当前网关状态标识。 |
| `lastReadyAt` | `number \| null` | 是 | 最近一次进入可用状态的时间戳。 |
| `lastInboundAt` | `number \| null` | 是 | 最近一次接收入站事件的时间戳。 |
| `lastOutboundAt` | `number \| null` | 是 | 最近一次发送出站事件的时间戳。 |
| `lastHeartbeatAt` | `number \| null` | 是 | 最近一次心跳时间戳。 |
| `providerCalls` | `RuntimeTraceProviderCall[]` | 是 | 已记录的 Provider 调用轨迹。 |
| `facts` | `RuntimeTraceFact[]` | 是 | 已记录的 fact 轨迹。 |
| `uplinks` | `Array<{ type: string; toolSessionId?: string }>` | 是 | 已记录的上行事件轨迹。 |
| `terminals` | `RuntimeTraceTerminal[]` | 是 | 已记录的 run 终态轨迹。 |
| `interactions` | `RuntimeTraceInteraction[]` | 是 | 已记录的交互轨迹。 |
| `derivedEvents` | `Array<{ type: string; toolSessionId: string }>` | 是 | 已记录的派生事件轨迹。 |
| `failures` | `RuntimeTraceFailure[]` | 是 | 已记录的失败轨迹。 |

```ts
const diagnostics = runtime.getDiagnostics();
```

## 4. Provider API

### 4.1 `initialize(context)`

用于接收 Runtime 注入的运行时上下文。

| 项目 | 说明 |
|---|---|
| 接口名 | `ThirdPartyAgentProvider.initialize` |
| 入参 | `ProviderRuntimeContext` |
| 出参 | `Promise<void>` |
| 说明 | Runtime 启动时注入上下文。 |

#### 入参类型：`ProviderRuntimeContext`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `outbound` | `RuntimeOutboundEmitter` | 是 | request run 之外主动发送消息的统一出口。 |

- 该接口为可选实现。
- 若实现，应保证调用安全。

### 4.2 `health(input)`

用于查询 Provider 当前是否在线可用。

| 项目 | 说明 |
|---|---|
| 接口名 | `ThirdPartyAgentProvider.health` |
| 入参 | `ProviderHealthInput` |
| 出参 | `Promise<ProviderHealthResult>` |
| 说明 | 返回当前 Provider 可用性。 |

#### 入参类型：`ProviderHealthInput`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `traceId` | `string` | 是 | 本次调用 traceId。 |

#### 出参类型：`ProviderHealthResult`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `online` | `boolean` | 是 | 当前 Provider 是否在线可用。 |

```ts
async health() {
  return { online: true };
}
```

### 4.3 `createSession(input)`

用于创建或映射一个可用会话。

| 项目 | 说明 |
|---|---|
| 接口名 | `ThirdPartyAgentProvider.createSession` |
| 入参 | `ProviderCreateSessionInput` |
| 出参 | `Promise<ProviderCreateSessionResult>` |
| 说明 | 返回会话标识。 |

#### 入参类型：`ProviderCreateSessionInput`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `traceId` | `string` | 是 | 本次调用 traceId。 |
| `title` | `string` | 否 | 可选会话标题。 |
| `assistantId` | `string` | 否 | 可选 assistant 标识。 |
| `extParameters` | `ExtParameters` | 否 | 扩展参数；与 `runMessage` 复用同一扩展参数契约。SDK 仅透传，不解释业务语义。 |

#### 出参类型：`ProviderCreateSessionResult`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `toolSessionId` | `string` | 是 | 宿主返回的会话标识。 |
| `title` | `string` | 否 | 宿主确认后的会话标题。 |

```ts
async createSession() {
  return { toolSessionId: 'tool-session-1' };
}
```

### 4.4 `runMessage(input)`

用于启动一次 request run。

| 项目 | 说明 |
|---|---|
| 接口名 | `ThirdPartyAgentProvider.runMessage` |
| 入参 | `ProviderRunMessageInput` |
| 出参 | `Promise<ProviderRun>` |
| 说明 | 返回本次运行句柄。 |

#### 入参类型：`ProviderRunMessageInput`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `traceId` | `string` | 是 | 本次调用 traceId。 |
| `runId` | `string` | 是 | 当前 request run 标识。 |
| `toolSessionId` | `string` | 是 | 目标会话标识。 |
| `text` | `string` | 是 | 本次用户输入文本。 |
| `assistantId` | `string` | 否 | 可选 assistant 标识。 |
| `extParameters` | `ExtParameters` | 否 | 平台/业务扩展参数；当前正式协议字段见下表。SDK 仅透传，不解释业务语义。 |
| `context.assistantAccount` | `string` | 否 | 可选 assistant 账号信息。 |
| `context.sendUserAccount` | `string` | 否 | 可选发送用户账号信息。 |
| `context.imGroupId` | `string` | 否 | 可选群组标识。 |
| `context.suppressReply` | `boolean` | 否 | 可选回复抑制标记。 |

#### 扩展类型：`ExtParameters`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `businessExtParam` | `JsonValue` | 否 | 业务扩展参数透传字段。 |
| `platformExtParam` | `PlatformExtParam` | 否 | 平台扩展参数透传字段。 |

#### 扩展类型：`PlatformExtParam`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `businessSessionDomain` | `string` | 否 | 业务入口所属域。 |
| `businessSessionType` | `string` | 否 | 业务入口类型。 |
| `businessSessionId` | `string` | 否 | 业务入口唯一标识。 |
| `allowedSlashCommands` | `string[]` | 否 | 请求级平台扩展命令集合。 |

#### 业务入口字段当前正式支持值

| `businessSessionDomain` | `businessSessionType` | `businessSessionId` | 说明 |
|---|---|---|---|
| `im` | `direct` | 例如：`user-a#bot-a` | IM 单聊业务入口。 |
| `im` | `group` | 例如：`group-a` | IM 群会话业务入口。 |
| `miniapp` | `direct` | 例如：`miniapp-user-1` | MiniApp direct 业务入口。 |

- 业务入口字段由 `businessSessionDomain`、`businessSessionType`、`businessSessionId` 三者共同组成。
- `businessSessionId` 示例仅用于说明当前协议形态，不展开生成、补全或推导规则。
- `bridge-runtime-sdk` 对 `extParameters` 仅做透传，不在 SDK 内解释业务路由语义。
- `allowedSlashCommands` 仅作为当前已定义扩展字段说明，不在本节展开链路差异。

#### 出参类型：`ProviderRun`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `runId` | `string` | 是 | 当前 run 的唯一标识，必须与 `ProviderRunMessageInput.runId` 一致。 |
| `facts` | `AsyncIterable<ProviderFact>` | 是 | 当前 run 产生的事实流。 |
| `result` | `() => Promise<ProviderTerminalResult>` | 是 | 返回当前 run 的最终结果。 |

#### 紧邻出参类型：`ProviderTerminalResult`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `outcome` | `'completed' \| 'failed' \| 'aborted'` | 是 | 当前 run 的最终结局。 |
| `usage` | `unknown` | 否 | 可选用量信息。 |
| `error` | `ProviderError` | 否 | 失败或中止时的补充错误信息。 |

#### 关键时序图

```mermaid
sequenceDiagram
  participant RT as Runtime
  participant P as Provider

  RT->>P: runMessage(input)
  P-->>RT: ProviderRun { runId, facts, result() }

  P-->>RT: message.start
  P-->>RT: text.delta / thinking.delta / tool.update
  P-->>RT: text.done / thinking.done
  P-->>RT: message.done

  P-->>RT: result() => ProviderTerminalResult
```

- 返回的 `ProviderRun.runId` 必须与输入 `input.runId` 一致。
- `facts` 按产生顺序消费，不是无序事件集合。
- `message.start` 必须先于所属消息的内容事件，`message.done` 用于消息流收口。
- `message.done` 不等于 run 终态；run 最终结局以 `ProviderRun.result()` 为准。
- `ProviderRun.result()` 是该次 run 的终态真源。
- `completed` 表示正常完成，`failed` 表示执行失败，`aborted` 表示中止。

```ts
async runMessage(input: ProviderRunMessageInput) {
  return {
    runId: input.runId,
    facts: (async function* () {})(),
    async result() {
      return { outcome: 'completed' } as const;
    },
  };
}
```

### 4.5 `replyQuestion(input)`

用于应用一次问题回复。

| 项目 | 说明 |
|---|---|
| 接口名 | `ThirdPartyAgentProvider.replyQuestion` |
| 入参 | `ProviderQuestionReplyInput` |
| 出参 | `Promise<{ applied: true }>` |
| 说明 | 应用待回复问题的答案。 |

#### 入参类型：`ProviderQuestionReplyInput`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `traceId` | `string` | 是 | 本次调用 traceId。 |
| `questionId` | `string` | 是 | 目标问题标识。 |
| `answers` | `QuestionAnswer[]` | 是 | 问题答案集合。每一项是一个字符串数组。 |

- 返回 `{ applied: true }` 时，表示回复已真实应用到底层宿主。

### 4.6 `replyPermission(input)`

用于应用一次权限回复。

| 项目 | 说明 |
|---|---|
| 接口名 | `ThirdPartyAgentProvider.replyPermission` |
| 入参 | `ProviderPermissionReplyInput` |
| 出参 | `Promise<{ applied: true }>` |
| 说明 | 应用待确认权限的回复。 |

#### 入参类型：`ProviderPermissionReplyInput`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `traceId` | `string` | 是 | 本次调用 traceId。 |
| `permissionId` | `string` | 是 | 目标权限标识。 |
| `reply` | `'once' \| 'always' \| 'reject'` | 是 | 权限回复结果。 |

- 返回 `{ applied: true }` 时，表示回复已真实应用到底层宿主。

### 4.7 `closeSession(input)`

用于关闭指定会话。

| 项目 | 说明 |
|---|---|
| 接口名 | `ThirdPartyAgentProvider.closeSession` |
| 入参 | `ProviderCloseSessionInput` |
| 出参 | `Promise<{ applied: true }>` |
| 说明 | 关闭目标会话。 |

#### 入参类型：`ProviderCloseSessionInput`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `traceId` | `string` | 是 | 本次调用 traceId。 |
| `toolSessionId` | `string` | 是 | 目标会话标识。 |

- 返回 `{ applied: true }` 时，表示关闭操作已真实应用到底层宿主。

### 4.8 `abortSession(input)`

用于中止指定执行或会话。

| 项目 | 说明 |
|---|---|
| 接口名 | `ThirdPartyAgentProvider.abortSession` |
| 入参 | `ProviderAbortSessionInput` |
| 出参 | `Promise<{ applied: true }>` |
| 说明 | 中止目标执行或会话。 |

#### 入参类型：`ProviderAbortSessionInput`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `traceId` | `string` | 是 | 本次调用 traceId。 |
| `toolSessionId` | `string` | 是 | 目标会话标识。 |
| `runId` | `string` | 否 | 需要中止的具体 run 标识；未提供时由宿主自行决定中止范围。 |

- 返回 `{ applied: true }` 时，表示中止操作已真实应用到底层宿主。

### 4.9 `dispose()`

用于在 Runtime 停止时执行清理。

| 项目 | 说明 |
|---|---|
| 接口名 | `ThirdPartyAgentProvider.dispose` |
| 入参 | 无 |
| 出参 | `Promise<void>` |
| 说明 | 执行 Provider 清理逻辑。 |

- 该接口为可选实现。

### 4.10 `emitOutboundMessage(input)`

用于发送 outbound 事实流。

| 项目 | 说明 |
|---|---|
| 接口名 | `RuntimeOutboundEmitter.emitOutboundMessage` |
| 入参 | `EmitOutboundMessageInput` |
| 出参 | `Promise<{ applied: true }>` |
| 说明 | 发送一批 outbound facts。 |

#### 入参类型：`EmitOutboundMessageInput`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `toolSessionId` | `string` | 是 | 目标会话标识。 |
| `messageId` | `string` | 是 | 本批 outbound 所属消息 ID。 |
| `trigger` | `'scheduled' \| 'webhook' \| 'system' \| string` | 是 | 主动消息触发来源。 |
| `facts` | `AsyncIterable<OutboundFact>` | 是 | 本批 outbound 事实流。 |
| `assistantId` | `string` | 否 | 可选 assistant 标识。 |

- outbound 只用于 request run 之外的主动消息。
- 集成方不得用 outbound 代替 `runMessage()` 的正常回复路径。
- 同一批 outbound facts 的 `messageId` 必须与 `EmitOutboundMessageInput.messageId` 一致。

## 5. 二维码授权 API

### 5.1 `qrcodeAuth.run(input)`

用于启动二维码授权流程。

| 项目 | 说明 |
|---|---|
| 接口名 | `qrcodeAuth.run` |
| 入参 | `QrCodeAuthRunInput` |
| 出参 | `Promise<void>` |
| 说明 | 启动二维码授权并通过快照回调返回进度。 |

#### 入参类型：`QrCodeAuthRunInput`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `environment` | `'uat' \| 'prod'` | 否 | 授权环境。未提供时默认 `prod`。 |
| `channel` | `string` | 是 | 授权渠道标识。 |
| `mac` | `string` | 是 | 设备标识。 |
| `policy.refreshOnExpired` | `boolean` | 否 | 二维码过期后是否自动刷新。 |
| `policy.maxRefreshCount` | `number` | 否 | 最大自动刷新次数。 |
| `policy.pollIntervalMs` | `number` | 否 | 轮询间隔，单位毫秒。 |
| `onSnapshot` | `(snapshot: QrCodeAuthSnapshot) => void` | 是 | 快照回调。 |

#### 关联类型：`QrCodeAuthSnapshot`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'qrcode_generated' \| 'scanned' \| 'expired' \| 'cancelled' \| 'confirmed' \| 'failed'` | 是 | 当前授权事件类型。 |
| `qrcode` | `string` | 否 | 当前二维码内容。不同事件是否携带取决于具体快照。 |
| `display` | `{ qrcode: string; weUrl: string; pcUrl: string }` | 否 | 仅二维码生成事件携带的展示数据。 |
| `expiresAt` | `string` | 否 | 仅二维码生成事件携带的过期时间。 |
| `credentials.ak` | `string` | 否 | 仅确认成功事件携带的 AK。 |
| `credentials.sk` | `string` | 否 | 仅确认成功事件携带的 SK。 |
| `reasonCode` | `'timeout' \| 'network_error' \| 'auth_service_error'` | 否 | 仅失败事件携带的失败原因。 |
| `serviceError` | `QrCodeAuthServiceError` | 否 | 仅失败事件携带的服务错误信息。 |

- `qrcodeAuth.run()` 由调用方直接调用，不通过 `createBridgeRuntime()` 获取。
- 调用方必须自行提供 `channel`、`mac` 和 `onSnapshot`。
- 调用方应按 `snapshot.type` 分支处理快照，而不是假设所有字段始终存在。

```ts
import { qrcodeAuth } from '@wecode/bridge-runtime-sdk';

await qrcodeAuth.run({
  channel: 'openx',
  mac: 'device-mac',
  onSnapshot(snapshot) {
    console.log(snapshot.type);
  },
});
```

## 6. 整体主流程时序图

```mermaid
sequenceDiagram
  participant I as Integrator
  participant RT as Runtime
  participant P as Provider

  I->>RT: createBridgeRuntime(options)
  I->>RT: start()
  opt initialized
    RT->>P: initialize(context)
  end

  RT->>P: createSession(input)
  RT->>P: runMessage(input)
  P-->>RT: ProviderRun { runId, facts, result() }
  P-->>RT: facts stream

  opt interaction reply
    RT->>P: replyQuestion(input)
    RT->>P: replyPermission(input)
  end

  P-->>RT: result() => ProviderTerminalResult
  I->>RT: stop()
  opt cleanup
    RT->>P: dispose()
  end
```

- `createBridgeRuntime()` 只创建实例，`start()` 成功后 Runtime 才进入可处理请求状态。
- `createSession()`、`runMessage()`、`replyQuestion()`、`replyPermission()` 都属于 Runtime 对 Provider 的调用路径。
- `runMessage()` 返回的是 `ProviderRun` 句柄，不是最终结果；run 的终态以 `result()` 为准。
- `stop()` 后 Runtime 不再继续使用旧上下文；若实现了 `dispose()`，会进入清理阶段。

## 7. 公共类型与通用约束

### 7.1 `ProviderFact` 与 `OutboundFact`

`ProviderFact` 是 request run 使用的事实集合，`OutboundFact` 与其共用同一套事实类型。两者差别只在生命周期来源：

- request run 通过 `ProviderRun.facts` 产出，并由 `result()` 收口
- outbound 通过 `emitOutboundMessage()` 主动发送，不包含 `runId`，也不通过 `result()` 收口

### 7.2 事实类型分组

- 消息生命周期：`message.start`、`message.done`
- 文本输出：`text.delta`、`text.done`
- 思考输出：`thinking.delta`、`thinking.done`
- 工具状态：`tool.update`
- 交互请求与回复：`question.ask`、`permission.ask`、`permission.reply`
- 会话信息：`session.title`
- 会话错误：`session.error`

### 7.3 主要 fact 字段

#### `MessageStartFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'message.start'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `messageId` | `string` | 是 | 所属消息标识。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

#### `TextDeltaFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'text.delta'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `messageId` | `string` | 是 | 所属消息标识。 |
| `partId` | `string` | 是 | 文本片段标识。 |
| `content` | `string` | 是 | 当前文本增量。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

#### `TextDoneFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'text.done'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `messageId` | `string` | 是 | 所属消息标识。 |
| `partId` | `string` | 是 | 文本片段标识。 |
| `content` | `string` | 是 | 当前片段最终内容。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

#### `ThinkingDeltaFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'thinking.delta'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `messageId` | `string` | 是 | 所属消息标识。 |
| `partId` | `string` | 是 | 思考片段标识。 |
| `content` | `string` | 是 | 当前思考增量。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

#### `ThinkingDoneFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'thinking.done'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `messageId` | `string` | 是 | 所属消息标识。 |
| `partId` | `string` | 是 | 思考片段标识。 |
| `content` | `string` | 是 | 当前片段最终内容。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

#### `ToolUpdateFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'tool.update'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `messageId` | `string` | 是 | 所属消息标识。 |
| `partId` | `string` | 是 | 工具片段标识。 |
| `toolCallId` | `string` | 是 | 工具调用标识。 |
| `toolName` | `string` | 是 | 工具名称。 |
| `status` | `'pending' \| 'running' \| 'completed' \| 'error'` | 是 | 当前工具状态。 |
| `title` | `string` | 否 | 可选标题。 |
| `input` | `string` | 否 | 可选输入内容。 |
| `output` | `string` | 否 | 可选输出内容。 |
| `error` | `string` | 否 | 工具错误说明。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

#### `QuestionAskFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'question.ask'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `messageId` | `string` | 是 | 所属消息标识。 |
| `partId` | `string` | 是 | 问题所在消息片段标识。 |
| `questionId` | `string` | 是 | 直接回复目标，必须唯一。 |
| `questions` | `QuestionItem[]` | 是 | 问题定义集合。 |
| `toolCallId` | `string` | 否 | 可选工具调用关联标识。 |
| `status` | `string` | 否 | 可选状态说明。 |
| `extParam` | `unknown` | 否 | 可选扩展信息。 |
| `context` | `Record<string, unknown>` | 否 | 可选上下文。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

#### `QuestionItem`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `question` | `string` | 是 | 问题正文。 |
| `header` | `string` | 否 | 可选问题标题。 |
| `options` | `QuestionOption[]` | 否 | 可选答案选项。 |
| `multiSelect` | `boolean` | 否 | 是否允许多选。 |

#### `QuestionOption`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `label` | `string` | 是 | 选项显示文本，也是 `question_reply.answers` 回传的答案值。 |
| `description` | `string` | 否 | 选项展示说明，仅用于上行展示；缺失时省略，不参与回复目标、路由或答案结构。 |

#### `PermissionAskFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'permission.ask'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `messageId` | `string` | 是 | 所属消息标识。 |
| `partId` | `string` | 是 | 权限所在消息片段标识。 |
| `permissionId` | `string` | 是 | 直接回复目标，必须唯一。 |
| `permissionType` | `string` | 否 | 可选权限类型。 |
| `title` | `string` | 否 | 可选权限标题。 |
| `metadata` | `Record<string, unknown>` | 否 | 可选权限上下文。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

#### `PermissionReplyFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'permission.reply'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `permissionId` | `string` | 是 | 已回复的权限标识。 |
| `response` | `'once' \| 'always' \| 'reject'` | 是 | 权限回复结果。 |
| `messageId` | `string` | 否 | 可选关联消息标识。 |
| `partId` | `string` | 否 | 可选关联片段标识。 |
| `permissionType` | `string` | 否 | 可选权限类型。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

#### `MessageDoneFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'message.done'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `messageId` | `string` | 是 | 所属消息标识。 |
| `reason` | `string` | 否 | 可选结束原因。 |
| `tokens` | `unknown` | 否 | 可选令牌统计。 |
| `cost` | `number` | 否 | 可选成本信息。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

#### `SessionTitleFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'session.title'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `title` | `string` | 是 | 新的会话标题。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

#### `SessionErrorFact`

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `type` | `'session.error'` | 是 | 事实类型。 |
| `toolSessionId` | `string` | 是 | 所属会话标识。 |
| `error` | `ProviderError` | 是 | 会话级错误信息。 |
| `raw` | `unknown` | 否 | 宿主原始上下文。 |

### 7.4 文本流规则

- `message.start` 表示一条消息开始。
- `text.delta` 用于发送尚未收口的文本增量。
- `text.done` 表示对应 `partId` 的文本片段已经收口。
- `message.done` 表示该消息的 fact 流结束，但不代表 request run 终态。
- 若某个片段一开始就是完整内容，可以只发送 `text.done`，不发送 `text.delta`。

最小合法文本序列如下：

```ts
yield { type: 'message.start', toolSessionId, messageId };
yield { type: 'text.done', toolSessionId, messageId, partId: 'part-1', content: 'hello' };
yield { type: 'message.done', toolSessionId, messageId };
```

### 7.5 标识符约束

- `toolSessionId` 标识会话作用域。
- `messageId` 必须在所属 `toolSessionId` 内唯一。
- `partId` 必须稳定标识同一文本、思考或工具片段。
- `runId` 绑定一次 request run，不得由 Provider 改写。
- `questionId` 与 `permissionId` 是直接回复目标，必须可唯一定位到底层宿主对象。

### 7.6 `ProviderError`

用于表达执行期错误或 run 失败原因。

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `code` | `'not_found' \| 'session_not_found' \| 'invalid_input' \| 'not_supported' \| 'timeout' \| 'rate_limited' \| 'provider_unavailable' \| 'internal_error'` | 是 | 错误码。 |
| `message` | `string` | 是 | 错误说明。 |
| `retryable` | `boolean` | 否 | 是否建议重试。 |
| `details` | `Record<string, unknown>` | 否 | 可选补充上下文。 |

### 7.7 `ProviderCommandError`

用于表达命令应用阶段失败。

| 字段 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `code` | `'invalid_input' \| 'not_found' \| 'not_supported' \| 'provider_unavailable' \| 'internal_error'` | 是 | 错误码。 |
| `message` | `string` | 是 | 错误说明。 |
| `retryable` | `boolean` | 否 | 是否建议重试。 |
| `details` | `Record<string, unknown>` | 否 | 可选补充上下文。 |

### 7.8 失败表达边界

- Provider 方法在命令应用阶段失败时，应抛出 `ProviderCommandError`。
- 宿主需要在事实流中表达会话级错误时，应发送 `SessionErrorFact`。
- request run 的最终结局必须通过 `ProviderRun.result()` 返回。
- 集成方不得把命令应用失败伪装成 `ProviderTerminalResult.error`。
- 集成方不得用 `SessionErrorFact` 代替 `ProviderRun.result()` 收口。

## 8. 最小接入示例

### 8.1 最小 Provider 示例

```ts
import type {
  ProviderFact,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
  ProviderTerminalResult,
  ThirdPartyAgentProvider,
} from '@wecode/bridge-runtime-sdk';

function fromArray<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

function createRun(runId: string, toolSessionId: string, text: string): ProviderRun {
  const facts: ProviderFact[] = [
    { type: 'message.start', toolSessionId, messageId: 'msg-1' },
    { type: 'text.done', toolSessionId, messageId: 'msg-1', partId: 'part-1', content: text },
    { type: 'message.done', toolSessionId, messageId: 'msg-1' },
  ];

  return {
    runId,
    facts: fromArray(facts),
    async result(): Promise<ProviderTerminalResult> {
      return { outcome: 'completed' };
    },
  };
}

export class DemoProvider implements ThirdPartyAgentProvider {
  private outbound = null as ProviderRuntimeContext['outbound'] | null;

  async initialize(context: ProviderRuntimeContext): Promise<void> {
    this.outbound = context.outbound;
  }

  async health() {
    return { online: true };
  }

  async createSession() {
    return { toolSessionId: 'tool-session-1' };
  }

  async runMessage(input: ProviderRunMessageInput) {
    return createRun(input.runId, input.toolSessionId, `echo: ${input.text}`);
  }

  async replyQuestion() {
    return { applied: true };
  }

  async replyPermission() {
    return { applied: true };
  }

  async closeSession() {
    return { applied: true };
  }

  async abortSession() {
    return { applied: true };
  }
}
```

### 8.2 最小文本输出示例

```ts
async runMessage(input: ProviderRunMessageInput): Promise<ProviderRun> {
  const messageId = `msg-${input.runId}`;

  return {
    runId: input.runId,
    facts: (async function* () {
      yield { type: 'message.start', toolSessionId: input.toolSessionId, messageId };
      yield {
        type: 'text.delta',
        toolSessionId: input.toolSessionId,
        messageId,
        partId: 'part-1',
        content: 'hel',
      };
      yield {
        type: 'text.done',
        toolSessionId: input.toolSessionId,
        messageId,
        partId: 'part-1',
        content: 'hello',
      };
      yield { type: 'message.done', toolSessionId: input.toolSessionId, messageId };
    })(),
    async result() {
      return { outcome: 'completed' };
    },
  };
}
```

### 8.3 挂起交互与回复示例

```ts
async runMessage(input: ProviderRunMessageInput): Promise<ProviderRun> {
  return {
    runId: input.runId,
    facts: (async function* () {
      yield { type: 'message.start', toolSessionId: input.toolSessionId, messageId: 'msg-q-1' };
      yield {
        type: 'question.ask',
        toolSessionId: input.toolSessionId,
        messageId: 'msg-q-1',
        partId: 'part-q-1',
        questionId: 'question-1',
        questions: [
          {
            question: '请选择部署环境',
            options: [
              { label: 'staging', description: '部署到预发环境' },
              { label: 'production', description: '部署到生产环境' },
            ],
          },
        ],
      };
    })(),
    async result() {
      return { outcome: 'aborted' };
    },
  };
}

async replyQuestion(input: ProviderQuestionReplyInput) {
  console.log(input.questionId, input.answers);
  return { applied: true };
}
```

### 8.4 常见错误用法

- 用 `message.done` 代替 `result()` 收口。
- 返回的 `ProviderRun.runId` 与输入 `runId` 不一致。
- 在 Runtime 已停止后继续使用旧的 outbound 发送器。
- 在同一消息中复用同一个 `partId` 表示不同文本片段。
