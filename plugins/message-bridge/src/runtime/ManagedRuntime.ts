import type { BridgeEvent } from './types.js';

export interface ManagedRuntimeStartOptions {
  abortSignal?: AbortSignal;
}

/**
 * 插件 runtime 在 singleton 中暴露的最小统一接口。
 * @remarks
 * singleton 只关心生命周期与宿主事件入口，不感知底层是 legacy runtime
 * 还是 SDK runtime。
 */
export interface ManagedRuntime {
  start(options?: ManagedRuntimeStartOptions): Promise<void>;
  stop(): void | Promise<void>;
  handleEvent(event: BridgeEvent): Promise<void>;
  getStarted(): boolean;
}
