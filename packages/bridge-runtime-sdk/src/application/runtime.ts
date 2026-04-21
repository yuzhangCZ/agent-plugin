import type { RuntimeDiagnostics } from './runtime-trace.ts';

/**
 * 对外稳定暴露的 host runtime 状态。
 * @remarks
 * 这里只表达宿主生命周期，不复用 gateway-client 的底层状态机枚举。
 */
export type BridgeRuntimeStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'reconnecting'
  | 'stopping'
  | 'failed';

/**
 * 对外稳定暴露的 host runtime 状态快照。
 */
export interface BridgeRuntimeStatusSnapshot {
  state: BridgeRuntimeStatus;
  failureReason: string | null;
}

/**
 * 对外稳定暴露的 host runtime facade。
 */
export interface BridgeRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): BridgeRuntimeStatusSnapshot;
  getDiagnostics(): RuntimeDiagnostics;
}
