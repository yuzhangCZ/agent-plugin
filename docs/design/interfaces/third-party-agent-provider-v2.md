# 三方 Agent Provider 对外接口文档 v2

**Version:** 2.0-draft  
**Date:** 2026-04-17  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [bridge-runtime-sdk 目标态架构设计](../../architecture/bridge-runtime-sdk-architecture.md), [Gateway Schema / Protocol 架构设计](../../architecture/gateway-schema-architecture.md), [三方 Agent 集成接口文档 v1](./third-party-agent-provider-v1.md)

## 1. 文档定位

本文是三方 Agent 接入的对外接口文档，面向 Provider 实现方，不面向平台内部事件模型消费者。

本文只负责定义接入方必须理解的外部契约：

- `ThirdPartyAgentProvider` SPI
- `ProviderFact`
- `ProviderRun`
- `ProviderTerminalResult`
- `ProviderError`
- `ProviderCommandError`
- `toolSessionId`、`messageId`、`trigger`
- request run / outbound 的事实流约束
- `replyQuestion()`、`replyPermission()`、`abortSession()`、`closeSession()`、`result()` 的 effect-level contract

本文不负责定义：

- Runtime 内部事件模型
- 平台内部投影链路
- 协议层业务消息术语
- 协议字段表、validator 与字面量真源

若需理解 Runtime 内部事件与协议投影，请参见：

- [bridge-runtime-sdk 目标态架构设计](../../architecture/bridge-runtime-sdk-architecture.md)
- [Gateway Schema / Protocol 架构设计](../../architecture/gateway-schema-architecture.md)

## 2. 角色与责任边界

Provider 的责任只有两类：

- 向 Runtime 提供 `ProviderFact`
- 响应 Runtime 下发的命令

Provider 不负责：

- 定义或派生 Runtime 内部统一事件模型
- 构造 AI Gateway 协议消息
- 推断平台内部 projector、sink、registry 或 facade 的实现细节

协议层架构术语与当前代码导出类型不要求一一同名。当前实现中的 `GatewayOutboundMessage`、`GatewaySendPayload`、`GatewayBusinessMessage` 可能与协议层目标术语语义对应，但本轮不要求名称完全一致，也不允许当前实现命名反向约束目标态文档。

## 3. Provider SPI

### 3.1 Runtime 注入上下文

```ts
export interface ProviderRuntimeContext {
  outbound: RuntimeOutboundEmitter;
}

export interface RuntimeOutboundEmitter {
  emitOutboundMessage(input: EmitOutboundMessageInput): Promise<{ applied: true }>;
}
```

### 3.2 `ThirdPartyAgentProvider`

```ts
export interface ThirdPartyAgentProvider {
  initialize?(context: ProviderRuntimeContext): Promise<void>;

  health(input: ProviderHealthInput): Promise<ProviderHealthResult>;

  createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult>;

  runMessage(input: ProviderRunMessageInput): Promise<ProviderRun>;

  replyQuestion(input: ProviderQuestionReplyInput): Promise<{ applied: true }>;

  replyPermission(input: ProviderPermissionReplyInput): Promise<{ applied: true }>;

  closeSession(input: ProviderCloseSessionInput): Promise<{ applied: true }>;

  abortSession(input: ProviderAbortSessionInput): Promise<{ applied: true }>;

  dispose?(): Promise<void>;
}
```

### 3.3 输入输出类型

```ts
export interface ProviderHealthInput {
  traceId: string;
}

export interface ProviderHealthResult {
  online: boolean;
}

export interface ProviderCreateSessionInput {
  traceId: string;
  title?: string;
  assistantId?: string;
}

export interface ProviderCreateSessionResult {
  toolSessionId: string;
  title?: string;
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

export interface EmitOutboundMessageInput {
  toolSessionId: string;
  messageId: string;
  trigger: 'scheduled' | 'webhook' | 'system' | string;
  facts: AsyncIterable<OutboundFact>;
  assistantId?: string;
}
```

### 3.4 Runtime 可能触发的 Provider 调用

本文只从 Provider 视角说明 Runtime 可能触发哪些 SPI 调用，不定义协议层角色、分类或结果映射。

| Runtime 触发来源 | 可能对应的下行 request | Provider SPI |
|---|---|---|
| 状态查询 | `status_query` | `health()` |
| 会话创建 | `invoke.create_session` | `createSession()` |
| 启动 request run | `invoke.chat` | `runMessage()` |
| 回复问题 | `invoke.question_reply` | `replyQuestion()` |
| 回复权限 | `invoke.permission_reply` | `replyPermission()` |
| 关闭会话 | `invoke.close_session` | `closeSession()` |
| 中止执行 | `invoke.abort_session` | `abortSession()` |

若需理解协议层术语与命令角色分工，请参见 [Gateway Schema / Protocol 架构设计](../../architecture/gateway-schema-architecture.md)；若需理解 Runtime 如何在内部编排这些调用，请参见 [bridge-runtime-sdk 目标态架构设计](../../architecture/bridge-runtime-sdk-architecture.md)。

## 4. 错误与终态模型

### 4.1 `ProviderRun`

```ts
export interface ProviderRun {
  runId: string;
  facts: AsyncIterable<ProviderFact>;
  result(): Promise<ProviderTerminalResult>;
}
```

### 4.2 `ProviderTerminalResult`

```ts
export interface ProviderTerminalResult {
  outcome: 'completed' | 'failed' | 'aborted';
  usage?: unknown;
  error?: ProviderError;
}
```

### 4.3 `ProviderError`

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

### 4.4 `ProviderCommandError`

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

### 4.5 错误边界

- `ProviderCommandError` 只用于表达 Provider 在命令应用阶段返回的失败。
- `ProviderError` 只用于表达执行期错误与 request run 终态失败原因。
- 两者不能混用，也不能互相降级或升级。
- Runtime 自身的内部校验、状态机拒绝、事件投影失败，不属于 Provider 错误模型。

## 5. 标识模型

### 5.1 `toolSessionId`

- `toolSessionId` 是 Runtime 与 Provider 共享的统一会话主键。
- `toolSessionId` 只能来自 AI Gateway 已知会话，或 `createSession()` 成功后的宿主返回值。
- Provider 不应暴露宿主私有会话 ID 作为另一套正式外部主键。

### 5.2 `messageId`

- `messageId` 由 Provider 生成。
- `messageId` 必须在所属 `toolSessionId` 内唯一。
- request run 与 outbound 的所有 message 级 fact 都必须显式携带 `messageId`。
- `EmitOutboundMessageInput.messageId` 必须与该批次内所有 fact 的 `messageId` 一致。

### 5.3 `trigger`

- `trigger` 用于描述 outbound message 的触发来源。
- `trigger` 是辅助分类字段，不是生命周期主键，也不是状态判定条件。
- Runtime 不应基于 `trigger` 改变 outbound 的生命周期语义。

推荐取值：

- `scheduled`
- `webhook`
- `system`

## 6. 事实模型

### 6.1 `ProviderFact`

```ts
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

```ts
export interface MessageStartFact {
  type: 'message.start';
  toolSessionId: string;
  messageId: string;
  raw?: unknown;
}

export interface TextDeltaFact {
  type: 'text.delta';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

export interface TextDoneFact {
  type: 'text.done';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

export interface ThinkingDeltaFact {
  type: 'thinking.delta';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

export interface ThinkingDoneFact {
  type: 'thinking.done';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

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

export interface MessageDoneFact {
  type: 'message.done';
  toolSessionId: string;
  messageId: string;
  reason?: string;
  tokens?: unknown;
  cost?: number;
  raw?: unknown;
}

export interface SessionErrorFact {
  type: 'session.error';
  toolSessionId: string;
  error: ProviderError;
  raw?: unknown;
}
```

### 6.2 `OutboundFact`

```ts
export type OutboundFact = ProviderFact;
```

request run 与 outbound 共享同一套事实能力。差异只体现在生命周期，不体现在事实类型集合。

## 7. 行为契约

### 7.1 request run

- `runMessage()` 成功返回，表示 request run 已在底层宿主侧成功启动。
- `ProviderRun.facts` 是该次 request run 的事实流。
- `ProviderRun.result()` 是 request run 终态真源。
- `message.done` 或 `session.error` 不能替代 `result()` 作为终态结论。

`result()` 的一致性约束：

- `outcome: 'completed'` 时，`error` 必须为空。
- `outcome: 'failed'` 时，失败原因应通过 `error` 表达。
- `outcome: 'aborted'` 时，`error` 默认应为空；如需补充上下文，应放在 `details`。

### 7.2 outbound

- `emitOutboundMessage()` 成功返回，表示该批 outbound facts 已应用到 Runtime。
- outbound 不是 request run，不提供 `runId`，也不暴露 `result()`。
- Runtime 不应把 outbound 伪装成 `ProviderRun`。

### 7.3 回复、关闭与中止

- `replyQuestion()` 成功返回 `{ applied: true }`，表示回复已应用到底层 agent/runtime，而不是仅仅进入待处理队列。
- `replyPermission()` 成功返回 `{ applied: true }`，表示回复已应用到底层 agent/runtime，而不是仅仅进入待处理队列。
- `closeSession()` 成功返回 `{ applied: true }`，表示关闭动作已应用到底层会话。
- `abortSession()` 成功返回 `{ applied: true }`，表示中止动作已应用到底层执行体或会话。

若上述方法在命令应用阶段失败，必须 reject 或 throw `ProviderCommandError`。

### 7.4 并发与一致性约束

- 同一 `toolSessionId` 任一时刻最多只允许一个活跃 request run。
- 同一 `toolSessionId` 任一时刻最多只允许一个活跃 outbound message 流。
- 同一批 outbound facts 的 `messageId` 必须一致。
- Provider 只负责提供事实与命令执行结果，不负责派生平台内部消费事件。

## 8. 非目标

本文不回答以下问题：

- Runtime 内部如何把 `ProviderFact` 投影成统一业务事件
- 协议层如何定义 `tool_event`、`tool_done`、`tool_error`
- AI Gateway 上下行协议的字段真源位于何处

这些内容分别由 [bridge-runtime-sdk 目标态架构设计](../../architecture/bridge-runtime-sdk-architecture.md) 和 [Gateway Schema / Protocol 架构设计](../../architecture/gateway-schema-architecture.md) 承接。
