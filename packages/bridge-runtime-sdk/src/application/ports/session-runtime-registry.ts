export interface RequestRunState {
  activeRunIds: readonly string[];
}

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
  registerRequestRun(toolSessionId: string, runId: string): RequestRunState;
  releaseRequestRun(toolSessionId: string, runId: string): RequestRunState;
  getRequestRunState(toolSessionId: string): RequestRunState;
  hasActiveRequestRun(toolSessionId: string): boolean;
  acquireOutboundEmission(toolSessionId: string, messageId: string): { ok: true; record: SessionRuntimeRecord } | { ok: false };
  releaseOutboundEmission(toolSessionId: string, messageId: string): void;
  getOutboundEmissionState(toolSessionId: string): OutboundEmissionState;
}
