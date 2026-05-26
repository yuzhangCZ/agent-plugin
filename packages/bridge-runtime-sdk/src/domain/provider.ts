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

export interface ProviderFactBase {
  // 仅透传 provider 提供的子代理 envelope 提示，不承担 runtime session ownership 语义。
  subagentSessionId?: string;
  subagentName?: string;
}

export interface MessageStartFact extends ProviderFactBase {
  type: 'message.start';
  messageId: string;
  // 这里保留 unknown：raw 只用于 trace/诊断，不进入稳定 runtime 语义。
  raw?: unknown;
}

export interface TextDeltaFact extends ProviderFactBase {
  type: 'text.delta';
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

export interface TextDoneFact extends ProviderFactBase {
  type: 'text.done';
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

export interface ThinkingDeltaFact extends ProviderFactBase {
  type: 'thinking.delta';
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

export interface ThinkingDoneFact extends ProviderFactBase {
  type: 'thinking.done';
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

export interface ToolUpdateFact extends ProviderFactBase {
  type: 'tool.update';
  messageId: string;
  partId: string;
  toolCallId: string;
  toolName: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  title?: string;
  input?: string;
  output?: string;
  error?: string;
  raw?: unknown;
}

export interface QuestionOption {
  label: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionAskFact extends ProviderFactBase {
  type: 'question.ask';
  messageId: string;
  // partId 只表示消息组成部分 ID，不承担 direct reply target 语义。
  partId: string;
  // questionId 是全局唯一的 question reply target，不依赖 toolSessionId 二次定位。
  questionId: string;
  // questions[] 是问题事实的唯一真源；兼容展示字段由 projector 或下游自行从 questions[0] 读取。
  questions: QuestionItem[];
  // 可选 toolCallId 仅用于关联原始 tool call；未传时 projector 会回填为 questionId 兼容旧下游字段读取口径，
  // 但不会改变 runtime 内部仍以 questionId 作为 reply target 的语义。
  toolCallId?: string;
  status?: string;
  // 这里保留 unknown：extParam 是 cloud event 透传上下文，不属于稳定业务字段。
  extParam?: unknown;
  // 这里保留 unknown：交互上下文是 provider 透传边界信息，不属于稳定协议字段。
  context?: Record<string, unknown>;
  raw?: unknown;
}

export interface PermissionAskFact extends ProviderFactBase {
  type: 'permission.ask';
  /**
   * 可选消息归属上下文。
   * permission 交互在 provider 现实中不总是天然 message-scoped，
   * 因此 runtime 只把它当作可透传的诊断/展示上下文。
   */
  messageId?: string;
  partId: string;
  // permissionId 是全局唯一的 permission reply target，不依赖 toolSessionId 二次定位。
  permissionId: string;
  permissionType?: string;
  title?: string;
  // 这里保留 unknown：metadata 是 provider 私有补充信息，仅用于透传和诊断。
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface PermissionReplyFact extends ProviderFactBase {
  type: 'permission.reply';
  permissionId: string;
  response: 'once' | 'always' | 'reject';
  permissionType?: string;
  raw?: unknown;
}

export interface MessageDoneFact extends ProviderFactBase {
  type: 'message.done';
  messageId: string;
  reason?: string;
  tokens?: unknown;
  cost?: number;
  raw?: unknown;
}

export interface SessionTitleFact extends ProviderFactBase {
  type: 'session.title';
  title: string;
  raw?: unknown;
}

export interface SessionErrorFact extends ProviderFactBase {
  type: 'session.error';
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
  | PermissionReplyFact
  | MessageDoneFact
  | SessionTitleFact
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

import type { ExtParameters } from '../../../gateway-schema/src/contract/types/ext-parameters.ts';

export interface ProviderHealthInput {
  traceId: string;
}

export interface ProviderHealthResult {
  online: boolean;
}

export interface ProviderCreateSessionInput {
  traceId: string;
  welinkSessionId?: string;
  title?: string;
  assistantId?: string;
  extParameters?: ExtParameters;
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
  // extParameters 来自 personal chat payload，SDK 仅透传，不参与业务语义处理。
  extParameters?: ExtParameters;
  context?: {
    assistantAccount?: string;
    sendUserAccount?: string;
    imGroupId?: string;
    suppressReply?: boolean;
  };
}

export type QuestionAnswer = string[];

export interface ProviderQuestionReplyInput {
  traceId: string;
  questionId: string;
  answers: QuestionAnswer[];
}

export interface ProviderPermissionReplyInput {
  traceId: string;
  permissionId: string;
  reply: 'once' | 'always' | 'reject';
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
