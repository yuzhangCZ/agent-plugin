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

/** 宿主会话列表查询条件，只表达传给 host session.list 的筛选参数。 */
export interface HostSessionListQuery {
  directory?: string;
  roots?: boolean;
  start?: number;
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
  /** 最终上下文来源；“最近活跃会话”定义为 `listSessions()` 返回的第一个结果。 */
  bootstrapSource: 'existing_binding' | 'bootstrap_reused_recent_session' | 'bootstrap_created';
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

/** chat 触发的建会话原始上下文。 */
export interface HostSessionCreateContext {
  assistantId?: string;
}

/** slash 命令语法树。 */
export type SlashCommand =
  | { kind: 'new' }
  | { kind: 'sessions' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'models' }
  | { kind: 'model'; providerId: string; modelId: string };

/** slash 命令意图；用于非法参数等未形成完整语法树的失败回包。 */
export interface SlashCommandDescriptor {
  kind: SlashCommand['kind'];
}

/** bridge-local slash parser 输入：文本已由 chat classifier 完成场景规范化。 */
export interface BridgeLocalSlashCommandParseInput {
  text: string;
}

/** bridge-local slash parser 三态结果：命中、已知本地命令但参数非法、非本地命令。 */
export type BridgeLocalSlashCommandParseResult =
  | { kind: 'matched'; command: SlashCommand }
  | { kind: 'invalid'; command: SlashCommandDescriptor }
  | { kind: 'none' };

/** slash 失败码：只表达控制面错误事实，不承载用户文案。 */
export type SlashCommandFailureCode =
  | 'session_not_found'
  | 'session_out_of_scope'
  | 'model_not_found'
  | 'invalid_command'
  | 'command_disabled_in_group_chat'
  | 'sdk_unreachable';

/** 受控失败原因键：仅允许进入统一文案策略的白名单原因。 */
export type SlashCommandFailureReasonKey =
  | 'current_session_unavailable'
  | 'target_session_out_of_scope'
  | 'target_model_unavailable'
  | 'unsupported_command'
  | 'command_not_available_in_group_chat'
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

/**
 * 维护宿主会话到外部锚点的回流归属。
 * @remarks 一个 host session 当前只解析到一个 attached owner；当多个 anchor 绑定同一
 * host session 时，attached owner 表示最近一次成功使用该 session 的 anchor。TUI
 * detached outbound run 创建时会锁定当时 owner，后续 owner 变化不影响已创建 run。
 */
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
  resolve(
    anchor: ExternalConversationAnchor,
    createContext?: HostSessionCreateContext,
    logger?: BridgeLogger,
  ): Promise<SlashCommandContext>;
}

/** 宿主会话查询接口。 */
export interface HostSessionQueryPort {
  getSession(sessionId: string): Promise<HostSessionInfo>;
  listSessions(query: HostSessionListQuery): Promise<HostSessionInfo[]>;
}

/** 宿主会话创建接口。 */
export interface HostSessionCreationPort {
  createSession(input?: HostSessionCreateContext): Promise<HostSessionInfo>;
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

/** bridge-local slash 语法解析器，只识别 message-bridge 本地控制命令。 */
export interface BridgeLocalSlashCommandParser {
  tryParse(input: BridgeLocalSlashCommandParseInput): BridgeLocalSlashCommandParseResult;
}

/** slash 回包 presenter。 */
export interface SlashCommandReplyPresenter {
  presentSuccess(result: SlashCommandResult): string;
  presentFailure(command: SlashCommandDescriptor, error: SlashCommandFailure): string;
}
