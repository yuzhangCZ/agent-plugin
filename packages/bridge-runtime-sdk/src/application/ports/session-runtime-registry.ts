export type RequestRunState =
  | { status: 'idle' }
  | { status: 'running'; runId: string };

export type OutboundEmissionState =
  | { status: 'idle' }
  | { status: 'emitting'; messageId: string };

/**
 * runtime 对单个 toolSessionId 的本地协调视图。
 * @remarks 只表达 SDK 内 request run / outbound emission 的占用状态，不建模 native session 生命周期。
 */
export interface SessionRuntimeRecord {
  toolSessionId: string;
  welinkSessionId?: string;
  requestRun: RequestRunState;
  outbound: OutboundEmissionState;
}

/**
 * request run / outbound 的本地协调状态注册表。
 * @remarks 这是 application coordination port；delete 只清 SDK 本地缓存，不代表 native session tombstone。
 */
export interface SessionRuntimeRegistry {
  ensure(input: { toolSessionId: string; welinkSessionId?: string }): SessionRuntimeRecord;
  get(toolSessionId: string): SessionRuntimeRecord | undefined;
  delete(toolSessionId: string): void;
  acquireRequestRun(toolSessionId: string, runId: string): { ok: true; record: SessionRuntimeRecord } | { ok: false };
  releaseRequestRun(toolSessionId: string, runId: string): void;
  getRequestRunState(toolSessionId: string): RequestRunState;
  getActiveRequestRunId(toolSessionId: string): string | undefined;
  acquireOutboundEmission(toolSessionId: string, messageId: string): { ok: true; record: SessionRuntimeRecord } | { ok: false };
  releaseOutboundEmission(toolSessionId: string, messageId: string): void;
  getOutboundEmissionState(toolSessionId: string): OutboundEmissionState;
}
