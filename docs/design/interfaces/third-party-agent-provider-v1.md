# 三方 Agent 集成接口文档 v1

**Version:** 1.0-draft  
**Date:** 2026-03-30  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [bridge-refactor-architecture.md](../../architecture/bridge-refactor-architecture.md), [protocol-contract.md](../../../plugins/message-bridge/docs/design/interfaces/protocol-contract.md)

## 背景

本文面向三方 agent 集成方，定义接入 bridge 的 v1 外部接口。

你可以把 bridge 理解为一个托管运行时：

- 它负责和 gateway 建立连接
- 它负责把 gateway 下发的请求转成 provider 调用
- 它负责把 provider 返回的事件转换成 gateway 可消费的结果

集成方不需要直接处理 gateway 连接细节，也不需要直接构造 gateway 协议消息。  
你只需要：

1. 创建并启动 Runtime SDK
2. 实现一个 Provider
3. 在 Provider 中完成会话、消息执行、关闭和中断能力
4. 按文档要求输出事件流

本文档是 **v1 草案**。后续版本可能在保持兼容的前提下继续扩展。

## 范围

### In Scope

- Runtime SDK 的公开入口
- Provider 的最小实现接口
- 当前 v1 支持的下行能力
- 当前 v1 支持的外部事件模型
- 快速接入示例
- 外部集成方必须遵守的行为约束

### Out of Scope

- 内部实现细节
- gateway 协议内部结构说明
- provider 默认持久化方案
- `permission_reply`
- `question_reply`
- 权限与问答相关事件
- `reason` part type
- 未在本文列出的其他事件类型

### External Dependencies

- 可访问的 gateway 服务
- 合法的 AK / SK 凭证
- 三方 agent 自身的会话与消息执行能力

## 你需要做什么

对集成方来说，v1 接入只有两类工作：

### 1. 启动 Runtime SDK

Runtime SDK 负责：

- 建立连接
- 启动接入流程
- 接收请求
- 将请求转发给你实现的 Provider

### 2. 实现 Provider

Provider 负责：

- 返回宿主在线状态
- 创建宿主会话
- 执行一轮消息
- 关闭宿主会话
- 中断宿主会话
- 产出消息流和终态

## 快速开始

### 步骤 1：创建 Runtime

```ts
import { createBridgeRuntime } from '@your-scope/agent-bridge-sdk';

const runtime = createBridgeRuntime({
  gateway: {
    url: 'wss://gateway.example.com/ws/agent',
    ak: process.env.BRIDGE_AUTH_AK!,
    sk: process.env.BRIDGE_AUTH_SK!,
    channel: 'my-agent-channel',
  },
});
```

### 步骤 2：实现 Provider

```ts
import type {
  ThirdPartyAgentProvider,
  ProviderRun,
} from '@your-scope/agent-bridge-sdk';

class MyAgentProvider implements ThirdPartyAgentProvider {
  async health() {
    return { online: true };
  }

  async createSession(input) {
    const providerSessionId = await myAgent.createSession({
      title: input.title,
      assistantId: input.assistantId,
    });

    return { providerSessionId };
  }

  async runMessage(input): Promise<ProviderRun> {
    return {
      runId: input.runId,
      events: myAgent.stream({
        sessionId: input.providerSessionId,
        text: input.text,
      }),
      result: async () => ({
        outcome: 'completed',
      }),
    };
  }

  async closeSession(input) {
    await myAgent.closeSession(input.providerSessionId);
    return { accepted: true };
  }

  async abortSession(input) {
    await myAgent.abortSession(input.providerSessionId);
    return { accepted: true };
  }
}
```

### 步骤 3：注册 Provider 并启动

```ts
runtime.registerProvider(new MyAgentProvider());
await runtime.start();
```

## Runtime SDK

### API

```ts
export interface CreateBridgeRuntimeOptions {
  gateway: {
    url: string;
    ak: string;
    sk: string;
    channel: string;
    heartbeatIntervalMs?: number;
    reconnect?: {
      baseMs: number;
      maxMs: number;
      exponential: boolean;
    };
    readyTimeoutMs?: number;
  };
  logger?: BridgeLogger;
}

export interface BridgeRuntimeStatus {
  connectionState: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'READY';
  providerRegistered: boolean;
  gatewayReady: boolean;
}

export interface BridgeRuntimeSdk {
  registerProvider(provider: ThirdPartyAgentProvider): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): BridgeRuntimeStatus;
}

export function createBridgeRuntime(
  options: CreateBridgeRuntimeOptions,
): BridgeRuntimeSdk;
```

### 方法说明

| 方法 | 说明 |
|---|---|
| `createBridgeRuntime(options)` | 创建一个 Runtime SDK 实例 |
| `registerProvider(provider)` | 注册一个 Provider 实现 |
| `start()` | 建立连接并开始接收请求 |
| `stop()` | 停止运行并释放资源 |
| `getStatus()` | 获取当前运行状态 |

### 使用要求

- `registerProvider()` 必须在 `start()` 之前调用
- v1 只支持注册一个 Provider
- `start()` 成功后，runtime 才会开始对外提供服务

## Provider SPI

### API

```ts
export interface ThirdPartyAgentProvider {
  health(input: ProviderHealthInput): Promise<ProviderHealthResult>;

  createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult>;

  runMessage(input: ProviderRunMessageInput): Promise<ProviderRun>;

  closeSession(input: ProviderCloseSessionInput): Promise<{ accepted: true }>;

  abortSession(input: ProviderAbortSessionInput): Promise<{ accepted: true }>;

  dispose?(): Promise<void>;
}
```

### 方法说明

| 方法 | 用途 |
|---|---|
| `health()` | 返回当前 agent 是否在线 |
| `createSession()` | 创建一个新的宿主会话 |
| `runMessage()` | 执行一轮消息并返回事件流 |
| `closeSession()` | 关闭一个已存在的会话 |
| `abortSession()` | 中断一个正在执行的会话或运行 |
| `dispose()` | 可选，用于释放 provider 自身资源 |

## 请求与响应类型

```ts
export interface ProviderHealthInput {
  traceId: string;
}

export interface ProviderHealthResult {
  online: boolean;
}

export interface ProviderCreateSessionInput {
  traceId: string;
  toolSessionId: string;
  title?: string;
  assistantId?: string;
  context?: {
    correlationId?: string;
  };
}

export interface ProviderCreateSessionResult {
  providerSessionId: string;
  title?: string;
}

export interface ProviderRunMessageInput {
  traceId: string;
  runId: string;
  toolSessionId: string;
  providerSessionId: string;
  text: string;
  assistantId?: string;
  context?: {
    correlationId?: string;
  };
}

export interface ProviderCloseSessionInput {
  traceId: string;
  toolSessionId: string;
  providerSessionId: string;
}

export interface ProviderAbortSessionInput {
  traceId: string;
  runId?: string;
  toolSessionId: string;
  providerSessionId: string;
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `toolSessionId` | bridge 分配的会话标识 |
| `providerSessionId` | provider 自己的会话标识 |
| `runId` | 单次消息执行标识 |
| `traceId` | 诊断与追踪标识 |
| `assistantId` | 可选的助手或 agent 配置标识 |
| `context.correlationId` | 可选关联标识，用于日志或排障 |

说明：

- 集成方应将 `providerSessionId` 视为自己的主会话标识。
- 集成方不应假设 `toolSessionId` 和 `providerSessionId` 相同。

## Run 与事件流

### `ProviderRun`

```ts
export interface ProviderRun {
  runId: string;
  events: AsyncIterable<ProviderEvent>;
  result(): Promise<ProviderTerminalResult>;
}
```

### 说明

- `events` 用于输出流式事件
- `result()` 用于返回本次执行的最终结果
- `runId` 必须与输入中的 `runId` 一致

## 事件模型

v1 仅支持当前外部集成需要的最小事件集合。

```ts
export type ProviderEvent =
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ToolUpdatedEvent
  | SessionStatusEvent
  | RunTerminalEvent;
```

### `message.delta`

```ts
export interface MessageDeltaEvent {
  type: 'message.delta';
  toolSessionId: string;
  messageId: string;
  partId: string;
  delta: string;
  raw?: unknown;
}
```

用途：

- 输出文本增量
- 适合流式回复场景

### `message.completed`

```ts
export interface MessageCompletedEvent {
  type: 'message.completed';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}
```

用途：

- 输出一轮消息的最终完整内容
- 适合作为文本收敛结果

### `tool.updated`

```ts
export interface ToolUpdatedEvent {
  type: 'tool.updated';
  toolSessionId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  status: 'running' | 'completed' | 'error';
  title?: string;
  output?: unknown;
  error?: string;
  raw?: unknown;
}
```

用途：

- 表示工具调用状态变化
- 表示工具输出或错误

v1 约束：

- 当前不支持 `reason`
- 未列出的其他 part type 不属于 v1 契约

### `session.status`

```ts
export interface SessionStatusEvent {
  type: 'session.status';
  toolSessionId: string;
  status: 'busy' | 'idle';
  raw?: unknown;
}
```

用途：

- 表示当前会话是否处于执行中

### `run.terminal`

```ts
export interface RunTerminalEvent {
  type: 'run.terminal';
  toolSessionId: string;
  runId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  error?: ProviderError;
  raw?: unknown;
}

export interface ProviderTerminalResult {
  outcome: 'completed' | 'failed' | 'aborted';
  usage?: unknown;
  error?: ProviderError;
}

export interface ProviderError {
  code:
    | 'not_found'
    | 'invalid_input'
    | 'not_supported'
    | 'timeout'
    | 'provider_unavailable'
    | 'internal_error'
    | 'concurrent_run_not_supported';
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}
```

用途：

- 表示一轮运行的最终状态

## 支持的下行能力

v1 对集成方要求支持的能力如下：

| 能力 | Provider 方法 |
|---|---|
| 健康检查 | `health()` |
| 创建会话 | `createSession()` |
| 执行消息 | `runMessage()` |
| 关闭会话 | `closeSession()` |
| 中断会话 | `abortSession()` |

## 行为约束

集成方必须遵守以下规则：

1. 单个 `runId` 只能结束一次。
2. `run.terminal` 发出后，事件流必须结束。
3. `result()` 必须与 `run.terminal` 保持一致。
4. 如果不支持同一会话并发运行，必须返回明确错误：
   `concurrent_run_not_supported`
5. `closeSession()` / `abortSession()` 只表示请求已接受，不表示宿主已同步完成关闭或中断。
6. 未列入本文的事件类型不属于 v1 契约。
7. 外部契约中的事件名以本文定义为准，不要求与某个具体宿主的原始事件名一致。

## 实现建议

### 文本输出建议

推荐使用以下模式：

1. 流式输出过程：`message.delta`
2. 最终完整结果：`message.completed`

### 工具状态建议

推荐使用以下状态：

- 工具开始：`running`
- 工具成功结束：`completed`
- 工具失败：`error`

### 会话状态建议

推荐使用以下模式：

1. 执行开始时发送 `session.status = busy`
2. 执行结束前或结束时发送 `session.status = idle`

说明：

- v1 不单独定义 `session.idle`
- 外部消费方只需要监听 `session.status`

### 终态建议

每轮 `runMessage()` 最终都应输出一个 `run.terminal`：

- 正常完成：`completed`
- 执行失败：`failed`
- 主动中断：`aborted`

## 版本说明

本文档为 **v1 外部集成契约**。

v1 的目标是：

- 提供最小可接入能力
- 降低集成复杂度
- 先建立稳定的 Provider 实现模式

后续版本可能：

- 增加新的事件类型
- 增加新的字段
- 扩展更多 action 能力

如后续版本发生变化，将优先采用向后兼容方式扩展。

## FAQ

### 1. 我需要自己和 gateway 建立连接吗？

不需要。  
连接由 Runtime SDK 负责，你只需要创建 runtime 并注册 provider。

### 2. 我需要自己构造 gateway 上下行协议吗？

不需要。  
你只需要实现 Provider 接口，并输出本文定义的事件。

### 3. `toolSessionId` 和 `providerSessionId` 有什么区别？

- `toolSessionId` 是 bridge 分配给当前会话的外部标识
- `providerSessionId` 是你的 agent 系统内部会话标识

两者不要求相同。

### 4. 为什么 v1 不支持 `reason`？

因为 v1 先以当前外部消费面使用到的最小事件集为准。  
如果后续外部消费面明确需要 `reason`，会在后续版本中扩展。

### 5. 为什么外部事件名不直接使用 OpenCode 原始事件名？

因为本文档面向外部集成方，目标是提供稳定的 bridge 公共契约。  
如果直接使用某个宿主的原始事件名，会提高后续演进成本。

因此 v1 采用以下外部事件名：

- `message.delta`
- `message.completed`
- `tool.updated`
- `session.status`
- `run.terminal`

### 6. `closeSession()` 返回 accepted 是否表示一定关闭成功？

不表示。  
它只表示关闭请求已经被接受处理，不代表宿主已经同步完成关闭。
