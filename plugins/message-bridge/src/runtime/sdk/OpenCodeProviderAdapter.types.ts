import type { BridgeEvent } from '../types.js';
import type { ProviderFact } from '@wecode/bridge-runtime-sdk';
import type { ActiveProviderRunHandle } from './OpenCodeProviderAdapter.run.js';

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
  envelopeMessageId?: string;
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
 * raw event 路由决策的目标摘要。
 * @remarks
 * 该类型用于表达 active run、outbound fallback 或 fail-closed drop 的边界语义。
 */
export type EventRouteTarget =
  | { kind: 'active_run'; run: ActiveProviderRunHandle; anchorSessionId: string }
  | { kind: 'outbound'; anchorSessionId: string; reason: 'attached_owner' }
  | {
      kind: 'drop';
      reason: 'missing_active_run' | 'missing_outbound_target' | 'unsupported_event' | 'missing_session_identity';
    };

/**
 * outbound fallback 目标解析端口。
 * @remarks
 * 只能返回当前宿主会话已 attach 的 anchor，找不到时必须返回 `undefined` 并让调用方 fail-closed。
 */
export interface OutboundTargetResolverPort {
  resolve(hostSessionId: string): { anchorSessionId: string } | undefined;
}

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
  | (PendingInteractionRecordBase & {
      source: 'active_run';
      runId: string;
    })
  | (PendingInteractionRecordBase & {
      source: 'outbound';
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
