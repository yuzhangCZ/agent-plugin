# bridge-runtime-sdk 对外集成文档

**Version:** 1.0  
**Date:** 2026-04-23  
**Status:** Active  
**Owner:** agent-plugin maintainers  
**Related:** [bridge-runtime-sdk 目标态架构设计](../../architecture/bridge-runtime-sdk-architecture.md), [Gateway Schema / Protocol 架构设计](../../architecture/gateway-schema-architecture.md), [三方 Agent 集成接口文档 v1](./third-party-agent-provider-v1.md)

## 1. 文档定位

本文面向 `@agent-plugin/bridge-runtime-sdk` 的 API 使用方，说明如何基于当前实现接入一个第三方 Agent Provider，并通过 Runtime 与 AI Gateway 建立稳定的上下行闭环。

本文只覆盖根入口 `@agent-plugin/bridge-runtime-sdk` 的稳定导出与使用方式，重点包括：

- `createBridgeRuntime()` 的装配入口
- `BridgeRuntime` 的生命周期与诊断能力
- `ThirdPartyAgentProvider` SPI
- `ProviderRun`、`ProviderFact`、`OutboundFact`
- request run / outbound / interaction 的主要行为约束

本文不展开：

- Runtime 内部 projector、coordinator、registry 的实现细节
- `gateway-client` 的底层状态机与连接实现
- AI Gateway 协议字段真源

## 2. 稳定入口

常用导入示例：

```ts
import {
  createBridgeRuntime,
  type BridgeGatewayHostConfig,
  type BridgeGatewayProbeResult,
  type BridgeRuntime,
  type BridgeRuntimeOptions,
  type EmitOutboundMessageInput,
  type MessageDoneFact,
  type MessageStartFact,
  type OutboundFact,
  type ProviderCommandError,
  type ProviderCloseSessionInput,
  type ProviderCreateSessionInput,
  type ProviderCreateSessionResult,
  type ProviderError,
  type ProviderFact,
  type ProviderAbortSessionInput,
  type ProviderHealthInput,
  type ProviderHealthResult,
  type ProviderPermissionReplyInput,
  type ProviderQuestionReplyInput,
  type ProviderRun,
  type ProviderRunMessageInput,
  type ProviderRuntimeContext,
  type ProviderTerminalResult,
  type QuestionAskFact,
  type RuntimeOutboundEmitter,
  type ThirdPartyAgentProvider,
  type TextDeltaFact,
  type TextDoneFact,
  type ThinkingDeltaFact,
  type ThinkingDoneFact,
  type ToolUpdateFact,
  type PermissionAskFact,
  type SessionErrorFact,
} from '@agent-plugin/bridge-runtime-sdk';
```

本文中的对外接口说明都以 [packages/bridge-runtime-sdk/src/index.ts](/Users/zy/Code/agent-plugin/packages/bridge-runtime-sdk/src/index.ts) 为准。上面的代码块用于展示常见 public contract 的导入方式，不要求穷举全部导出。当前根入口同时导出 `ProviderFact` / `OutboundFact`、主要命令输入类型以及全部 fact 成员类型，便于 Provider 实现方为具体 fact 编写 helper、builder 与测试断言。`BridgeGatewayHostConnection`、`connectionFactory` 一类测试缝或内部装配细节，不属于对外集成契约。

## 3. 快速开始

### 3.1 实现一个最小 Provider

```ts
import type {
  ProviderFact,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderTerminalResult,
  ProviderRuntimeContext,
  ThirdPartyAgentProvider,
} from '@agent-plugin/bridge-runtime-sdk';

function fromArray<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

function createRun(toolSessionId: string, text: string): ProviderRun {
  const facts: ProviderFact[] = [
    { type: 'message.start', toolSessionId, messageId: 'msg-1' },
    { type: 'text.delta', toolSessionId, messageId: 'msg-1', partId: 'part-1', content: text.slice(0, 2) },
    { type: 'text.done', toolSessionId, messageId: 'msg-1', partId: 'part-1', content: text },
    { type: 'message.done', toolSessionId, messageId: 'msg-1' },
  ];

  return {
    runId: 'run-1',
    facts: fromArray(facts),
    async result(): Promise<ProviderTerminalResult> {
      return { outcome: 'completed' };
    },
  };
}

export class DemoProvider implements ThirdPartyAgentProvider {
  private runtimeContext: ProviderRuntimeContext | null = null;

  async initialize(context: ProviderRuntimeContext): Promise<void> {
    this.runtimeContext = context;
  }

  async health() {
    return { online: true };
  }

  async createSession() {
    return { toolSessionId: 'tool-session-1' };
  }

  async runMessage(input: ProviderRunMessageInput) {
    return createRun(input.toolSessionId, `echo: ${input.text}`);
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

### 3.2 创建并启动 Runtime

```ts
import {
  createBridgeRuntime,
  type BridgeGatewayHostConfig,
} from '@agent-plugin/bridge-runtime-sdk';
import { randomUUID } from 'node:crypto';

import { DemoProvider } from './DemoProvider';

const gatewayHost: BridgeGatewayHostConfig = {
  url: 'ws://gateway.local',
  auth: {
    ak: process.env.GATEWAY_AK!,
    sk: process.env.GATEWAY_SK!,
  },
  register: {
    toolType: 'openx',
    toolVersion: '0.0.0',
  },
};

const runtime = await createBridgeRuntime({
  provider: new DemoProvider(),
  gatewayHost,
  traceIdFactory: () => randomUUID(),
});

await runtime.start();

console.log(runtime.getStatus());

await runtime.stop();
```

`createBridgeRuntime()` 只负责创建 facade，不会在构造阶段立即建立 gateway 连接；真正的初始化、Provider `initialize()` 调用与连接建立发生在 `runtime.start()` 期间。

## 4. Runtime 装配接口

### 4.1 `BridgeRuntimeOptions`

```ts
/**
 * 创建并装配一个可直接连接 AI Gateway 的 Runtime 所需输入。
 * 使用方通常只需要提供 Provider 实现和网关配置，其余项用于观测和调试。
 */
export interface BridgeRuntimeOptions {
  /**
   * 宿主侧 Provider 实现，负责承接 Runtime 下发命令并产出事实流。
   */
  provider: ThirdPartyAgentProvider;
  /**
   * 建链、鉴权与 register 握手所需的最小网关配置。
   */
  gatewayHost: BridgeGatewayHostConfig;
  /**
   * 可选日志端口，用于接收 gateway 连接过程中的调试和异常信息。
   */
  logger?: BridgeGatewayLogger;
  /**
   * 是否打开 gateway-client 侧调试日志。
   */
  debug?: boolean;
  /**
   * 为每次下行请求生成 traceId；未提供时由 Runtime 自行生成。
   */
  traceIdFactory?: () => string;
  /**
   * 运行期遥测更新回调，适合驱动状态面板或调试观测。
   */
  onTelemetryUpdated?: () => void;
}
```

其中：

- `provider`：宿主适配实现，必填
- `gatewayHost`：网关地址、鉴权信息、注册元数据，必填
- `logger`：可选日志端口；根入口不单独导出 `BridgeGatewayLogger` 类型，直接传入兼容 `info` / `warn` / `error` 方法的对象即可
- `debug`：是否打开 gateway 侧调试日志
- `traceIdFactory`：为每次下行请求生成 traceId；未提供时 Runtime 会自行生成
- `onTelemetryUpdated`：网关状态、上下行时间戳或诊断数据更新时触发

### 4.2 `BridgeGatewayHostConfig`

```ts
/**
 * Runtime 与 AI Gateway 建立连接所需的最小稳定配置。
 * 这里只暴露宿主必须提供的连接身份和注册元数据。
 */
export interface BridgeGatewayHostConfig {
  /**
   * Gateway WebSocket 地址。
   */
  url: string;
  auth: {
    /**
     * Gateway 鉴权 AK。
     */
    ak: string;
    /**
     * Gateway 鉴权 SK。
     */
    sk: string;
  };
  register: {
    /**
     * 工具注册类型，沿用 gateway-client 的枚举约束。
     */
    toolType: BridgeGatewayToolType;
    /**
     * 当前宿主实现版本。
     */
    toolVersion: string;
  };
}
```

`toolType` 当前直接复用 `gateway-client` 的注册枚举约束；文档不重复枚举具体字面量，使用方应以当前导出类型检查结果为准。

### 4.3 `BridgeRuntime`

```ts
/**
 * 对外稳定暴露的 Runtime facade。
 * 使用方通过它启动、停止、探测网关并读取当前诊断信息。
 */
export interface BridgeRuntime {
  /**
   * 启动 Runtime。
   * 该调用会初始化 Provider，并建立到 AI Gateway 的连接。
   */
  start(): Promise<void>;
  /**
   * 停止 Runtime。
   * 该调用会断开连接，并触发 Provider 的可选清理逻辑。
   */
  stop(): Promise<void>;
  /**
   * 主动探测当前 gateway 配置是否可连通。
   * 不改变业务状态，只返回本次探测结果。
   */
  probe(input?: { timeoutMs: number }): Promise<BridgeGatewayProbeResult>;
  /**
   * 返回对外稳定的 Runtime 生命周期状态。
   */
  getStatus(): BridgeRuntimeStatusSnapshot;
  /**
   * 返回当前收集到的运行期诊断快照。
   */
  getDiagnostics(): RuntimeDiagnostics;
}
```

常见用法：

```ts
await runtime.start();

const probe = await runtime.probe({ timeoutMs: 3_000 });
console.log(probe.state, probe.reason);

const status = runtime.getStatus();
console.log(status.state, status.failureReason);

const diagnostics = runtime.getDiagnostics();
console.log(diagnostics.gatewayState, diagnostics.lastInboundAt);

await runtime.stop();
```

## 5. Provider SPI

### 5.1 接口定义

```ts
/**
 * 宿主需要实现的 Provider SPI。
 * Runtime 通过这组方法把下行请求应用到底层宿主，并消费宿主返回的事实流。
 */
export interface ThirdPartyAgentProvider {
  /**
   * Runtime 启动时的可选初始化入口。
   * 适合保存 outbound emitter 或建立宿主侧长生命周期资源。
   */
  initialize?(context: ProviderRuntimeContext): Promise<void>;
  /**
   * 查询 Provider 当前是否在线可用。
   */
  health(input: ProviderHealthInput): Promise<ProviderHealthResult>;
  /**
   * 创建或映射一个 Runtime 可识别的会话。
   */
  createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult>;
  /**
   * 启动一次 request run，并返回该次运行的事实流与终态句柄。
   */
  runMessage(input: ProviderRunMessageInput): Promise<ProviderRun>;
  /**
   * 应用一次问题回复。
   * 返回 `{ applied: true }` 表示已真正应用到底层宿主。
   */
  replyQuestion(input: ProviderQuestionReplyInput): Promise<{ applied: true }>;
  /**
   * 应用一次权限回复。
   * 返回 `{ applied: true }` 表示已真正应用到底层宿主。
   */
  replyPermission(input: ProviderPermissionReplyInput): Promise<{ applied: true }>;
  /**
   * 关闭指定会话。
   */
  closeSession(input: ProviderCloseSessionInput): Promise<{ applied: true }>;
  /**
   * 中止指定执行体或会话。
   */
  abortSession(input: ProviderAbortSessionInput): Promise<{ applied: true }>;
  /**
   * Runtime 停止时的可选清理入口。
   */
  dispose?(): Promise<void>;
}
```

Runtime 可能触发的主要调用路径：

| Runtime 入口 | Provider SPI | 用途 |
|---|---|---|
| `status_query` | `health()` | 查询 Provider 可用性 |
| `invoke.create_session` | `createSession()` | 创建或映射会话 |
| `invoke.chat` | `runMessage()` | 启动一次 request run |
| `invoke.question_reply` | `replyQuestion()` | 回复挂起问题 |
| `invoke.permission_reply` | `replyPermission()` | 回复权限请求 |
| `invoke.close_session` | `closeSession()` | 关闭会话 |
| `invoke.abort_session` | `abortSession()` | 中止执行 |

### 5.2 初始化上下文

```ts
/**
 * Runtime 在初始化阶段注入给 Provider 的上下文。
 * 当前只暴露 outbound emitter，用于 request run 之外的主动上行。
 */
export interface ProviderRuntimeContext {
  outbound: RuntimeOutboundEmitter;
}

/**
 * Provider 主动向 Runtime 提交一批 outbound facts 的统一出口。
 */
export interface RuntimeOutboundEmitter {
  /**
   * 应用一批 outbound facts。
   * 返回 `{ applied: true }` 表示该批事实已经被 Runtime 接收并进入校验/投影流程。
   */
  emitOutboundMessage(input: EmitOutboundMessageInput): Promise<{ applied: true }>;
}
```

如果宿主需要在 request run 之外主动向 Runtime 推送一批事实，应在 `initialize()` 中保存 `context.outbound`：

```ts
class DemoProvider implements ThirdPartyAgentProvider {
  private outbound: RuntimeOutboundEmitter | null = null;

  async initialize(context: ProviderRuntimeContext) {
    this.outbound = context.outbound;
  }

  async emitSystemNotice(toolSessionId: string): Promise<void> {
    if (!this.outbound) {
      throw new Error('runtime_not_initialized');
    }

    await this.outbound.emitOutboundMessage({
      toolSessionId,
      messageId: 'msg-system-1',
      trigger: 'system',
      facts: (async function* () {
        yield { type: 'message.start', toolSessionId, messageId: 'msg-system-1' } as const;
        yield {
          type: 'text.done',
          toolSessionId,
          messageId: 'msg-system-1',
          partId: 'part-1',
          content: 'system notice',
        } as const;
        yield { type: 'message.done', toolSessionId, messageId: 'msg-system-1' } as const;
      })(),
    });
  }
}
```

## 6. 主要输入输出类型

### 6.1 命令输入

```ts
export interface ProviderHealthInput {
  traceId: string;
}

export interface ProviderCreateSessionInput {
  traceId: string;
  title?: string;
  assistantId?: string;
}

export interface ProviderRunMessageInput {
  traceId: string;
  runId: string;
  toolSessionId: string;
  text: string;
  assistantId?: string;
}

export interface ProviderQuestionReplyInput {
  traceId: string;
  toolSessionId: string;
  toolCallId: string;
  answer: string;
}

export interface ProviderPermissionReplyInput {
  traceId: string;
  toolSessionId: string;
  permissionId: string;
  response: 'once' | 'always' | 'reject';
}

export interface ProviderCloseSessionInput {
  traceId: string;
  toolSessionId: string;
}

export interface ProviderAbortSessionInput {
  traceId: string;
  toolSessionId: string;
  runId?: string;
}
```

### 6.2 命令结果

```ts
export interface ProviderHealthResult {
  online: boolean;
}

export interface ProviderCreateSessionResult {
  toolSessionId: string;
  title?: string;
}
```

### 6.3 request run 句柄

```ts
/**
 * 一次 request run 的运行句柄。
 * 它同时提供增量事实流和终态收口入口。
 */
export interface ProviderRun {
  /**
   * 本次 request run 的宿主侧运行 ID。
   */
  runId: string;
  /**
   * 本次运行产生的事实流。
   */
  facts: AsyncIterable<ProviderFact>;
  /**
   * 返回本次 request run 的终态结果。
   * 这是 run outcome 的唯一真源。
   */
  result(): Promise<ProviderTerminalResult>;
}

/**
 * request run 的终态描述。
 * 用于表达完成、失败或中止，以及可选的失败原因和用量信息。
 */
export interface ProviderTerminalResult {
  /**
   * 运行结局。
   */
  outcome: 'completed' | 'failed' | 'aborted';
  /**
   * 可选用量信息，shape 由宿主自行定义。
   */
  usage?: unknown;
  /**
   * 失败时的错误信息；`completed` 时通常应为空。
   */
  error?: ProviderError;
}
```

`ProviderRun.result()` 是 run 终态真源。`message.done` 或 `session.error` 只是事实流中的事件，不能替代 `result()` 对最终 outcome 的定义。

## 7. 事实流模型

### 7.1 `ProviderFact`

```ts
/**
 * Provider 向 Runtime 提交的正式事实闭集。
 * Runtime 会基于这些事实做校验、状态推进和上行投影。
 */
export type ProviderFact =
  | MessageStartFact
  | TextDeltaFact
  | TextDoneFact
  | ThinkingDeltaFact
  | ThinkingDoneFact
  | ToolUpdateFact
  | QuestionAskFact
  | PermissionAskFact
  | MessageDoneFact
  | SessionErrorFact;
```

按语义分组如下：

- 消息生命周期：`message.start`、`message.done`
- 文本输出：`text.delta`、`text.done`
- 思考输出：`thinking.delta`、`thinking.done`
- 工具调用：`tool.update`
- 挂起交互：`question.ask`、`permission.ask`
- 会话错误：`session.error`

### 7.2 主要 fact shape

```ts
/**
 * 一条消息生命周期的开始。
 * 后续属于该消息的文本、工具或交互 fact 都应复用同一个 `messageId`。
 */
export interface MessageStartFact {
  type: 'message.start';
  toolSessionId: string;
  messageId: string;
  raw?: unknown;
}

/**
 * 文本增量输出。
 * 适合流式输出尚未收口的片段。
 */
export interface TextDeltaFact {
  type: 'text.delta';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

/**
 * 文本片段收口。
 * 表示对应 `partId` 的最终内容已经稳定。
 */
export interface TextDoneFact {
  type: 'text.done';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

/**
 * 工具调用执行过程中的状态更新。
 * 同一个 `toolCallId` 可以多次上报，从 pending 推进到 running / completed / error。
 */
export interface ToolUpdateFact {
  type: 'tool.update';
  toolSessionId: string;
  messageId: string;
  partId: string;
  toolCallId: string;
  toolName: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  title?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  raw?: unknown;
}

/**
 * 宿主向 Runtime 抛出一个待回复问题。
 * 后续通常会通过 `replyQuestion()` 回填答案。
 */
export interface QuestionAskFact {
  type: 'question.ask';
  toolSessionId: string;
  messageId: string;
  toolCallId: string;
  header?: string;
  question: string;
  options?: string[];
  context?: Record<string, unknown>;
  raw?: unknown;
}

/**
 * 宿主向 Runtime 抛出一个待确认权限请求。
 * 后续通常会通过 `replyPermission()` 回填决定。
 */
export interface PermissionAskFact {
  type: 'permission.ask';
  toolSessionId: string;
  messageId: string;
  permissionId: string;
  toolCallId?: string;
  permissionType?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

/**
 * 一条消息生命周期结束。
 * 它只表示该消息的 fact 流收口，不替代 run 终态。
 */
export interface MessageDoneFact {
  type: 'message.done';
  toolSessionId: string;
  messageId: string;
  reason?: string;
  tokens?: unknown;
  cost?: number;
  raw?: unknown;
}

/**
 * 会话级错误事实。
 * 用于表达宿主在事实流中主动上报的执行期错误。
 */
export interface SessionErrorFact {
  type: 'session.error';
  toolSessionId: string;
  error: ProviderError;
  raw?: unknown;
}
```

### 7.3 `OutboundFact`

```ts
/**
 * outbound 与 request run 共享同一套事实能力。
 * 差别只在于 outbound 没有 runId，也不通过 `result()` 收口。
 */
export type OutboundFact = ProviderFact;
```

outbound 和 request run 共享同一套事实集合，差别只在于生命周期来源不同：outbound 没有 `runId`，也没有 `result()` 收口。

## 8. 主路径代码示例

### 8.1 一次完整的 request run

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

推荐做法：

- `messageId` 在当前 `toolSessionId` 内保持唯一
- 同一个 `partId` 表示同一段流式片段
- 事实流结束后再由 `result()` 给出终态

### 8.2 抛出挂起问题并接收回复

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
        toolCallId: 'tool-call-1',
        question: '请选择部署环境',
        options: ['staging', 'production'],
      };
    })(),
    async result() {
      return { outcome: 'aborted' };
    },
  };
}

async replyQuestion(input: ProviderQuestionReplyInput) {
  console.log(input.toolCallId, input.answer);
  return { applied: true };
}
```

`replyQuestion()` 成功返回 `{ applied: true }`，表示回复已经应用到底层宿主，而不是仅仅进入某个待处理队列。

### 8.3 主动发送 outbound

```ts
await context.outbound.emitOutboundMessage({
  toolSessionId: 'tool-session-1',
  messageId: 'msg-outbound-1',
  trigger: 'webhook',
  facts: (async function* () {
    yield { type: 'message.start', toolSessionId: 'tool-session-1', messageId: 'msg-outbound-1' };
    yield {
      type: 'text.done',
      toolSessionId: 'tool-session-1',
      messageId: 'msg-outbound-1',
      partId: 'part-1',
      content: 'webhook event received',
    };
    yield { type: 'message.done', toolSessionId: 'tool-session-1', messageId: 'msg-outbound-1' };
  })(),
});
```

### 8.4 错误终态

```ts
async result(): Promise<ProviderTerminalResult> {
  return {
    outcome: 'failed',
    error: {
      code: 'provider_unavailable',
      message: 'upstream agent timeout',
      retryable: true,
    },
  };
}
```

## 9. 错误模型

### 9.1 `ProviderError`

```ts
export interface ProviderError {
  code:
    | 'not_found'
    | 'invalid_input'
    | 'not_supported'
    | 'timeout'
    | 'rate_limited'
    | 'provider_unavailable'
    | 'internal_error';
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}
```

用于表达执行期错误与失败终态原因，典型位置是：

- `ProviderTerminalResult.error`
- `SessionErrorFact.error`

### 9.2 `ProviderCommandError`

```ts
export interface ProviderCommandError {
  code:
    | 'invalid_input'
    | 'not_found'
    | 'not_supported'
    | 'provider_unavailable'
    | 'internal_error';
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}
```

用于表达命令应用阶段失败，例如：

- `replyQuestion()` 无法应用到宿主
- `closeSession()` 找不到目标会话
- `abortSession()` 在宿主层拒绝执行

这类失败发生在命令应用阶段，不属于 request run 终态；不要把它们塞进 `ProviderTerminalResult.error`。`replyPermission()`、`closeSession()`、`abortSession()` 的失败处理模式与 `replyQuestion()` 相同。

```ts
import type {
  ProviderCommandError,
  ProviderQuestionReplyInput,
} from '@agent-plugin/bridge-runtime-sdk';

async function replyQuestion(input: ProviderQuestionReplyInput): Promise<{ applied: true }> {
  if (!input.toolCallId) {
    throw {
      code: 'invalid_input',
      message: 'toolCallId is required',
    } satisfies ProviderCommandError;
  }

  const applied = await host.applyQuestionReply(input.toolCallId, input.answer);
  if (!applied) {
    throw {
      code: 'not_found',
      message: 'pending question not found',
      retryable: false,
    } satisfies ProviderCommandError;
  }

  return { applied: true };
}
```

## 10. 使用约束

- `toolSessionId` 是 Runtime 与 Provider 共享的统一会话主键。
- `messageId` 由 Provider 生成，必须在所属 `toolSessionId` 内唯一。
- 同一 `toolSessionId` 任一时刻最多只允许一个活跃 request run。
- 同一 `toolSessionId` 任一时刻最多只允许一个活跃 outbound message 流。
- 同一批 outbound facts 的 `messageId` 必须一致，并与 `EmitOutboundMessageInput.messageId` 一致。
- `outcome: 'completed'` 时，`error` 应为空。
- `outcome: 'failed'` 时，失败原因应通过 `error` 表达。
- `outcome: 'aborted'` 时，`error` 默认应为空；如需补充上下文，优先放在 `details`。
- `replyQuestion()`、`replyPermission()`、`closeSession()`、`abortSession()` 返回 `{ applied: true }` 时，都表示动作已真正应用到底层宿主。

## 11. 诊断与排障

`runtime.getDiagnostics()` 返回当前 Runtime 收集到的诊断快照，适合用于排查上下行链路是否按预期工作。

```ts
const diagnostics = runtime.getDiagnostics();

console.log({
  gatewayState: diagnostics.gatewayState,
  lastReadyAt: diagnostics.lastReadyAt,
  lastInboundAt: diagnostics.lastInboundAt,
  lastOutboundAt: diagnostics.lastOutboundAt,
  providerCalls: diagnostics.providerCalls,
  facts: diagnostics.facts,
  terminals: diagnostics.terminals,
  failures: diagnostics.failures,
});
```

常见排障方向：

- `gatewayState` 长时间不是 `READY`：先检查 gateway 配置与网络连通性
- `providerCalls` 有记录但 `facts` 为空：检查 Provider 是否正确产出 `AsyncIterable<ProviderFact>`
- `failures` 出现 `outbound_validation_failure`：检查 fact 序列与上行投影是否合法
- `terminals` 缺失：检查 `ProviderRun.result()` 是否完成收口
