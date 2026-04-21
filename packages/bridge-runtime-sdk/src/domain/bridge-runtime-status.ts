/**
 * Runtime 当前生命周期快照。
 */
export interface BridgeRuntimeStatus {
  /** 当前生命周期阶段。 */
  lifecycle: 'idle' | 'starting' | 'ready' | 'reconnecting' | 'stopping' | 'failed';
  /** 是否已注册 Provider。 */
  providerRegistered: boolean;
}
