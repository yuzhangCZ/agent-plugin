/**
 * Runtime 向宿主输出 outbound 事实时的统一成功结果。
 */
export interface RuntimeAppliedResult {
  applied: true;
}

/**
 * provider 回传的运行时错误。
 */
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

/**
 * provider 命令应用阶段错误。
 */
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

/**
 * provider 注入给 Runtime 的 outbound 发送器。
 */
export interface RuntimeOutboundEmitter {
  emitOutboundMessage(input: EmitOutboundMessageInput): Promise<RuntimeAppliedResult>;
}

/**
 * provider 运行时上下文。
 */
export interface ProviderRuntimeContext {
  outbound: RuntimeOutboundEmitter;
}

/**
 * provider 对外 SPI。
 */
export interface ThirdPartyAgentProvider {
  initialize?(context: ProviderRuntimeContext): Promise<void>;
  health(input: ProviderHealthInput): Promise<ProviderHealthResult>;
  createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult>;
  runMessage(input: ProviderRunMessageInput): Promise<ProviderRun>;
  replyQuestion(input: ProviderQuestionReplyInput): Promise<RuntimeAppliedResult>;
  replyPermission(input: ProviderPermissionReplyInput): Promise<RuntimeAppliedResult>;
  closeSession(input: ProviderCloseSessionInput): Promise<RuntimeAppliedResult>;
  abortSession(input: ProviderAbortSessionInput): Promise<RuntimeAppliedResult>;
  dispose?(): Promise<void>;
}

/**
 * provider 健康检查输入。
 */
export interface ProviderHealthInput {
  traceId: string;
}

/**
 * provider 健康检查结果。
 */
export interface ProviderHealthResult {
  online: boolean;
}

/**
 * 创建会话输入。
 */
export interface ProviderCreateSessionInput {
  traceId: string;
  title?: string;
  assistantId?: string;
}

/**
 * 创建会话结果。
 */
export interface ProviderCreateSessionResult {
  toolSessionId: string;
  title?: string;
}

/**
 * 启动 request run 输入。
 */
export interface ProviderRunMessageInput {
  traceId: string;
  runId: string;
  toolSessionId: string;
  text: string;
  assistantId?: string;
}

/**
 * 回复问题输入。
 */
export interface ProviderQuestionReplyInput {
  traceId: string;
  toolSessionId: string;
  toolCallId: string;
  answer: string;
}

/**
 * 回复权限输入。
 */
export interface ProviderPermissionReplyInput {
  traceId: string;
  toolSessionId: string;
  permissionId: string;
  response: 'once' | 'always' | 'reject';
}

/**
 * 关闭会话输入。
 */
export interface ProviderCloseSessionInput {
  traceId: string;
  toolSessionId: string;
}

/**
 * 中止执行输入。
 */
export interface ProviderAbortSessionInput {
  traceId: string;
  toolSessionId: string;
  runId?: string;
}

/**
 * outbound 批次输入。
 */
export interface EmitOutboundMessageInput {
  toolSessionId: string;
  messageId: string;
  trigger: 'scheduled' | 'webhook' | 'system' | string;
  facts: AsyncIterable<OutboundFact>;
  assistantId?: string;
}

/**
 * request run 的终态结果。
 */
export interface ProviderTerminalResult {
  outcome: 'completed' | 'failed' | 'aborted';
  usage?: unknown;
  error?: ProviderError;
}

/**
 * request run 的运行句柄。
 */
export interface ProviderRun {
  runId: string;
  facts: AsyncIterable<ProviderFact>;
  result(): Promise<ProviderTerminalResult>;
}

/**
 * 宿主事实流闭集。
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
 * outbound 事实与 request run 共用同一事实集合。
 */
export type OutboundFact = ProviderFact;

/**
 * 消息开始事实。
 */
export interface MessageStartFact {
  type: 'message.start';
  toolSessionId: string;
  messageId: string;
  raw?: unknown;
}

/**
 * 文本增量事实。
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
 * 文本收口事实。
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
 * 思考增量事实。
 */
export interface ThinkingDeltaFact {
  type: 'thinking.delta';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

/**
 * 思考收口事实。
 */
export interface ThinkingDoneFact {
  type: 'thinking.done';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

/**
 * 工具调用更新事实。
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
 * 问题挂起事实。
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
 * 权限挂起事实。
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
 * 消息完成事实。
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
 * 会话错误事实。
 */
export interface SessionErrorFact {
  type: 'session.error';
  toolSessionId: string;
  error: ProviderError;
  raw?: unknown;
}
