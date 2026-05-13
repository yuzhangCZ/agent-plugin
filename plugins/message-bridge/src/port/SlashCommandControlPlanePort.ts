import type { BridgeLogger } from '../types/logger.js';

/** 外部会话锚点：临时态由 `toolSessionId` 承载，正式态可切换到稳定业务会话主键。 */
export type ExternalConversationAnchor = string;

/** 当前锚点命中的宿主会话 binding 存储事实。 */
export interface ToolSessionBinding {
  anchor: ExternalConversationAnchor;
  activeOpencodeSessionId: string;
  status: 'active' | 'invalid';
}

/** 会话级模型覆盖，只绑定到宿主会话。 */
export interface SessionModelOverride {
  providerId: string;
  modelId: string;
}

/** 会话范围快照，只用于控制面判定。 */
export interface SessionScope {
  projectID?: string;
  workspaceID?: string;
  directory?: string;
}

/** 上行事件归属事实。 */
export interface SessionOwnership {
  opencodeSessionId: string;
  anchor: ExternalConversationAnchor;
  routeStatus: 'attached' | 'detached';
}

/** 控制面解析后的上下文。 */
export interface SlashCommandContext {
  anchor: ExternalConversationAnchor;
  activeOpencodeSessionId?: string;
  scope?: SessionScope;
  modelOverride?: SessionModelOverride;
  bootstrapSource: 'existing_binding' | 'bootstrap_created' | 'binding_invalidated';
}

/** 宿主会话最小视图。 */
export interface HostSessionInfo {
  id: string;
  title?: string;
  projectID?: string;
  workspaceID?: string;
  directory?: string;
}

/** 宿主模型目录项。 */
export interface HostModelInfo {
  providerId: string;
  modelId: string;
  label?: string;
}

/** slash 命令语法树。 */
export type SlashCommand =
  | { kind: 'new' }
  | { kind: 'sessions' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'models' }
  | { kind: 'model'; providerId: string; modelId: string };

/** slash 失败码：只表达控制面错误事实，不承载用户文案。 */
export type SlashCommandFailureCode =
  | 'session_not_found'
  | 'session_out_of_scope'
  | 'model_not_found'
  | 'invalid_command'
  | 'sdk_unreachable';

/** 受控失败原因键：仅允许进入统一文案策略的白名单原因。 */
export type SlashCommandFailureReasonKey =
  | 'current_session_unavailable'
  | 'target_session_out_of_scope'
  | 'target_model_unavailable'
  | 'unsupported_command'
  | 'host_unavailable';

/** slash 成功结果，供 presenter 组装回包文案。 */
export type SlashCommandResult =
  | { kind: 'new'; session: HostSessionInfo; previousSessionId?: string }
  | { kind: 'sessions'; sessions: HostSessionInfo[]; activeSessionId?: string }
  | { kind: 'session'; session: HostSessionInfo; previousSessionId?: string }
  | { kind: 'models'; models: HostModelInfo[] }
  | { kind: 'model'; sessionId: string; modelOverride: SessionModelOverride };

/** slash 失败结果。 */
export interface SlashCommandFailure {
  code: SlashCommandFailureCode;
  reasonKey?: SlashCommandFailureReasonKey;
}

/** 维护锚点到当前宿主会话的 binding。 */
export interface ToolSessionBindingStore {
  get(anchor: ExternalConversationAnchor): ToolSessionBinding | undefined;
  bind(anchor: ExternalConversationAnchor, opencodeSessionId: string): ToolSessionBinding;
  invalidate(anchor: ExternalConversationAnchor): void;
}

/** 维护宿主会话到外部锚点的回流归属。 */
export interface OpencodeSessionOwnershipResolver {
  attach(opencodeSessionId: string, anchor: ExternalConversationAnchor): void;
  detach(opencodeSessionId: string): void;
  resolveAttachedAnchor(opencodeSessionId: string): ExternalConversationAnchor | undefined;
}

/** 维护会话级模型覆盖。 */
export interface SessionModelOverrideStore {
  get(opencodeSessionId: string): SessionModelOverride | undefined;
  set(opencodeSessionId: string, override: SessionModelOverride): void;
  clear(opencodeSessionId: string): void;
}

/** 负责 bootstrap binding，并解析当前控制面上下文。 */
export interface SlashCommandContextResolver {
  resolve(anchor: ExternalConversationAnchor, logger?: BridgeLogger): Promise<SlashCommandContext>;
}

/** 宿主会话查询接口。 */
export interface HostSessionQueryPort {
  getSession(sessionId: string): Promise<HostSessionInfo>;
  listSessions(scope: SessionScope): Promise<HostSessionInfo[]>;
}

/** 宿主会话创建接口。 */
export interface HostSessionCreationPort {
  createSession(input?: { title?: string; directory?: string }): Promise<HostSessionInfo>;
}

/** 普通 chat 的宿主 prompt 执行接口。 */
export interface HostPromptExecutionPort {
  prompt(input: {
    sessionId: string;
    text: string;
    assistantId?: string;
    modelOverride?: SessionModelOverride;
    logger?: BridgeLogger;
  }): Promise<void>;
}

/** 模型目录查询接口。 */
export interface HostModelCatalogPort {
  listModels(): Promise<HostModelInfo[]>;
}

/** slash 语法解析器。 */
export interface SlashCommandParser {
  tryParse(text: string): SlashCommand | undefined;
}

/** slash 回包 presenter。 */
export interface SlashCommandReplyPresenter {
  presentSuccess(result: SlashCommandResult): string;
  presentFailure(command: SlashCommand, error: SlashCommandFailure): string;
}

/** slash 完成态发送端口。 */
export interface SlashCommandCompletionPort {
  completeSuccess(input: { anchor: ExternalConversationAnchor; text: string }): Promise<void>;
  completeFailure(input: { anchor: ExternalConversationAnchor; text: string }): Promise<void>;
}

/** 外层 gateway envelope 投影 seam。 */
export interface GatewayEnvelopeProjector {
  projectToolEvent(input: { anchor: ExternalConversationAnchor; text: string }): Record<string, unknown>;
  projectToolDone(input: { anchor: ExternalConversationAnchor }): Record<string, unknown>;
  projectToolError(input: { anchor: ExternalConversationAnchor; text: string }): Record<string, unknown>;
}
