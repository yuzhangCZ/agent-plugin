import type { ProviderCommandError, ProviderError } from './errors.ts';

/**
 * Provider 终态结果。
 */
export interface ProviderTerminalResult {
  outcome: 'completed' | 'failed' | 'aborted';
  // 这里保留 unknown：usage 仍是 provider 透传数据，SDK 首版不主定义其字段。
  usage?: unknown;
  error?: ProviderError;
}

export interface MessageStartFact {
  type: 'message.start';
  toolSessionId: string;
  messageId: string;
  // 这里保留 unknown：raw 只用于 trace/诊断，不进入稳定 runtime 语义。
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
  // 这里保留 unknown：交互上下文是 provider 透传边界信息，不属于稳定协议字段。
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
  // 这里保留 unknown：metadata 是 provider 私有补充信息，仅用于透传和诊断。
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

/**
 * Provider 向 runtime 提供的有序事实流。
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

/**
 * outbound 使用与 request run 相同的事实模型。
 */
export type OutboundFact = ProviderFact;

/**
 * 单次 request run 句柄。
 */
export interface ProviderRun {
  runId: string;
  facts: AsyncIterable<ProviderFact>;
  result(): Promise<ProviderTerminalResult>;
}

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

export interface RuntimeOutboundEmitter {
  emitOutboundMessage(input: EmitOutboundMessageInput): Promise<{ applied: true }>;
}

export interface ProviderRuntimeContext {
  outbound: RuntimeOutboundEmitter;
}

/**
 * SDK 对外暴露的 provider SPI。
 */
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

/**
 * Provider handler 统一返回的命令 apply 结果。
 */
export type ProviderApplyResult<T> = Promise<T> | T;

/**
 * Provider 入口允许直接抛结构化命令错误。
 */
export type ProviderCommandFailure = ProviderCommandError | Error;
