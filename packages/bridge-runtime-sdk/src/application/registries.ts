/**
 * session runtime 生命周期状态。
 */
export type SessionLifecycleState = 'active' | 'aborting' | 'closed';

export interface SessionRuntimeRecord {
  toolSessionId: string;
  welinkSessionId?: string;
  lifecycle: SessionLifecycleState;
  activeRunId?: string;
  activeOutboundMessageId?: string;
}

export interface PendingInteractionRecord {
  toolSessionId: string;
  kind: 'question' | 'permission';
  messageId?: string;
  tokenId: string;
}

export interface PendingInteractionConflict {
  current: PendingInteractionRecord;
  existing: PendingInteractionRecord;
}

export type PendingInteractionRegisterResult =
  | { ok: true }
  | { ok: false; reason: 'duplicate_same_session' }
  | { ok: false; reason: 'conflict_cross_session'; conflict: PendingInteractionConflict };

/**
 * request run / outbound 的局部状态注册表。
 */
export interface SessionRuntimeRegistry {
  ensure(input: { toolSessionId: string; welinkSessionId?: string }): SessionRuntimeRecord;
  get(toolSessionId: string): SessionRuntimeRecord | undefined;
  delete(toolSessionId: string): void;
  acquireActiveRun(toolSessionId: string, runId: string): { ok: true; record: SessionRuntimeRecord } | { ok: false };
  releaseActiveRun(toolSessionId: string, runId: string): void;
  acquireActiveOutbound(toolSessionId: string, messageId: string): { ok: true; record: SessionRuntimeRecord } | { ok: false };
  releaseActiveOutbound(toolSessionId: string, messageId: string): void;
  markAborting(toolSessionId: string): SessionRuntimeRecord | undefined;
  markClosed(toolSessionId: string): SessionRuntimeRecord | undefined;
}

/**
 * 挂起交互的原子 register / consume 注册表。
 */
export interface PendingInteractionRegistry {
  register(record: PendingInteractionRecord): PendingInteractionRegisterResult;
  consume(input: {
    kind: PendingInteractionRecord['kind'];
    tokenId: string;
  }): PendingInteractionRecord | undefined;
  clearSession(toolSessionId: string): void;
}
