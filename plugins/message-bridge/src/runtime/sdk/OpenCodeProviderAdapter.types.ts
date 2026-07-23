import type { BridgeEvent } from '../types.js';
import type { ProviderFact } from '@wecode/bridge-runtime-sdk';

/**
 * message part 在 provider fact 中的内容类别。
 */
export type PartKind = 'text' | 'reasoning';

/**
 * assistant message 是否已经对外发出 start/done 的生命周期状态。
 */
export type AssistantMessageLifecycleState = {
  startEmitted: boolean;
  doneEmitted: boolean;
};

/**
 * raw event 翻译后的 provider fact 包。
 * @remarks
 * `recognized=true` 表示事件类型已被 translator 接管；`facts=[]` 表示事件有效但当前状态下不应输出 fact。
 */
export type RawEventTranslation = {
  recognized: boolean;
  toolSessionId?: string;
  facts: ProviderFact[];
  terminalCandidateMessageId?: string;
};

/**
 * raw event 经过子会话映射后的会话身份。
 * @remarks
 * `hostSessionId` 用于 active run 队列定位，`trackingSessionId` 用于本地状态机隔离。
 */
export type EventSessionIdentity = {
  rawSessionId: string;
  trackingSessionId: string;
  hostSessionId: string;
  subagentSessionId?: string;
  subagentName?: string;
};

/**
 * active run 的最小身份摘要。
 */
export type ActiveRunIdentity = {
  anchorSessionId: string;
  hostSessionId: string;
  runId: string;
};

/**
 * raw session id 到宿主/子会话身份的解析结果。
 * @remarks
 * `resolved_fail_open` 表示映射查询失败但事件仍按 raw session 继续路由，避免本地索引异常扩大为消息丢失。
 */
export type SessionIdentityResolution =
  | {
      kind: 'resolved';
      rawSessionId: string;
      trackingSessionId: string;
      hostSessionId: string;
      subagentSessionId?: string;
      subagentName?: string;
    }
  | {
      kind: 'resolved_fail_open';
      rawSessionId: string;
      trackingSessionId: string;
      hostSessionId: string;
      lookupFailedCause: unknown;
    }
  | {
      kind: 'missing_session';
      rawSessionId?: string;
      reason: 'missing_event_session' | 'missing_parent_session';
      lookupFailedCause?: unknown;
    };

/**
 * fact 路由使用的会话上下文。
 * @remarks
 * `anchorSessionId` 面向 bridge-runtime-sdk；`trackingSessionId` 面向本地 lifecycle store。
 */
export type FactSessionContext = {
  anchorSessionId: string;
  trackingSessionId: string;
  subagentSessionId?: string;
  subagentName?: string;
};

/**
 * raw event 翻译过程中的协议诊断出口。
 * @remarks
 * 用于记录可恢复但值得关注的上游协议异常，调用方按 warn 级别输出。
 */
export interface ProtocolDiagnosticPort {
  warn(code: string, payload: Record<string, unknown>): void;
}

/**
 * raw event 翻译过程中的观察出口。
 */
export interface TranslationObservationPort {
  sessionUpdatedIgnored(reason: 'missing_session_id' | 'missing_title'): void;
}

/**
 * 待用户交互记录端口。
 * @remarks
 * question/permission fact 成功路由后记录 reply token 与宿主会话的关系；active run 记录必须携带 runId 供 timeout gate 查询。
 */
type PendingInteractionRecordBase = {
  kind: 'question' | 'permission';
  tokenId: string;
  toolSessionId: string;
  hostSessionId: string;
};

export type PendingInteractionRecorderInput =
  (PendingInteractionRecordBase & {
    source: 'active_run';
    runId: string;
  });

export interface PendingInteractionRecorderPort {
  record(input: PendingInteractionRecorderInput): void;
  hasPendingForRun?(input: { hostSessionId: string; runId: string }): boolean;
}

/**
 * assistant message 生命周期状态存储端口。
 */
export interface AssistantMessageStateStorePort {
  ensure(trackingSessionId: string, messageId: string): AssistantMessageLifecycleState;
  isOpen(trackingSessionId: string, messageId: string): boolean;
  clearSession(trackingSessionId: string): void;
  has(trackingSessionId: string): boolean;
}

/**
 * part 类型状态存储端口。
 */
export interface PartKindStorePort {
  remember(trackingSessionId: string, partId: string, kind: PartKind): void;
  resolve(trackingSessionId: string, partId: string): PartKind;
  clearSession(trackingSessionId: string): void;
  has(trackingSessionId: string): boolean;
}

/**
 * 单次 raw event 翻译所需的上下文。
 */
export type TranslationContext<TEvent extends BridgeEvent = BridgeEvent> = {
  event: TEvent;
  factSessionContext: FactSessionContext;
  assistantMessageState: AssistantMessageStateStorePort;
  partKindState: PartKindStorePort;
  diagnostics: ProtocolDiagnosticPort;
  observation: TranslationObservationPort;
};
