/**
 * session runtime 生命周期状态。
 */
export type SessionLifecycleState = 'active' | 'aborting' | 'closed';

/**
 * runtime 对单个 toolSession 的协调视图。
 */
export interface SessionRuntimeRecord {
  toolSessionId: string;
  welinkSessionId?: string;
  lifecycle: SessionLifecycleState;
  activeRunId?: string;
  activeOutboundMessageId?: string;
}

/**
 * request run / outbound 的局部状态注册表。
 * @remarks 这是 application coordination port，不是通用 repository。
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
