import type { ExtParameters } from '../../../gateway-schema/src/contract/types/ext-parameters.ts';

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
    | 'session_not_found'
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
  /**
   * personal chat payload 字段透传，Runtime SDK 不处理其业务语义。
   */
  extParameters?: ExtParameters;
  context?: {
    assistantAccount?: string;
    sendUserAccount?: string;
    imGroupId?: string;
    suppressReply?: boolean;
  };
}

/**
 * 回复问题输入。
 */
export type QuestionAnswer = string[];

export interface ProviderQuestionReplyInput {
  traceId: string;
  questionId: string;
  answers: QuestionAnswer[];
}

/**
 * 回复权限输入。
 */
export interface ProviderPermissionReplyInput {
  traceId: string;
  permissionId: string;
  reply: 'once' | 'always' | 'reject';
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

export interface ProviderFactBase {
  // 子代理 envelope 提示字段；不参与 runtime session ownership、校验或回复路由。
  subagentSessionId?: string;
  subagentName?: string;
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
  | PermissionReplyFact
  | MessageDoneFact
  | SessionTitleFact
  | SessionErrorFact;

/**
 * outbound 事实与 request run 共用同一事实集合。
 */
export type OutboundFact = ProviderFact;

/**
 * 消息开始事实。
 */
export interface MessageStartFact extends ProviderFactBase {
  type: 'message.start';
  messageId: string;
  raw?: unknown;
}

/**
 * 文本增量事实。
 */
export interface TextDeltaFact extends ProviderFactBase {
  type: 'text.delta';
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

/**
 * 文本收口事实。
 */
export interface TextDoneFact extends ProviderFactBase {
  type: 'text.done';
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

/**
 * 思考增量事实。
 */
export interface ThinkingDeltaFact extends ProviderFactBase {
  type: 'thinking.delta';
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

/**
 * 思考收口事实。
 */
export interface ThinkingDoneFact extends ProviderFactBase {
  type: 'thinking.done';
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

/**
 * 工具调用更新事实。
 */
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

/**
 * 问题挂起事实。
 */
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
  /**
   * 消息组成部分 ID；仅用于展示与 part 关联，不承担 direct reply target 语义。
   */
  partId: string;
  /**
   * 全局唯一的 question reply target。
   * runtime 与 provider 都只依赖它定位问题回复，不需要 `toolSessionId` 二次定位。
   */
  questionId: string;
  /**
   * 问题事实的唯一真源。
   * 下游如需兼容单问题展示，可自行从 `questions[0]` 派生快捷字段。
   */
  questions: QuestionItem[];
  /**
   * 可选 tool call 关联字段。
   * 未传时 cloud projector 会回填 `toolCallId = questionId` 以兼容旧下游字段读取口径，
   * 但 runtime 内部 reply target 仍只认 `questionId`。
   */
  toolCallId?: string;
  status?: string;
  extParam?: unknown;
  context?: Record<string, unknown>;
  raw?: unknown;
}

/**
 * 权限挂起事实。
 */
export interface PermissionAskFact extends ProviderFactBase {
  type: 'permission.ask';
  // permission 交互允许只按 session 归属；messageId 仅作为可选展示/诊断上下文透传。
  messageId?: string;
  partId: string;
  /**
   * 全局唯一的 permission reply target。
   * runtime 与 provider 都只依赖它定位权限回复，不需要 `toolSessionId` 二次定位。
   */
  permissionId: string;
  permissionType?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

/**
 * 权限回复事实。
 */
export interface PermissionReplyFact extends ProviderFactBase {
  type: 'permission.reply';
  permissionId: string;
  response: 'once' | 'always' | 'reject';
  messageId?: string;
  partId?: string;
  permissionType?: string;
  raw?: unknown;
}

/**
 * 消息完成事实。
 */
export interface MessageDoneFact extends ProviderFactBase {
  type: 'message.done';
  messageId: string;
  reason?: string;
  tokens?: unknown;
  cost?: number;
  raw?: unknown;
}

/**
 * 会话标题更新事实。
 */
export interface SessionTitleFact extends ProviderFactBase {
  type: 'session.title';
  title: string;
  raw?: unknown;
}

/**
 * 会话错误事实。
 */
export interface SessionErrorFact extends ProviderFactBase {
  type: 'session.error';
  error: ProviderError;
  raw?: unknown;
}
