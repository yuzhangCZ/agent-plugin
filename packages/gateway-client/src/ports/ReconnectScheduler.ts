// ReconnectScheduler 统一管理重连调度，避免 runtime 直接依赖全局 timer API。
export interface ReconnectScheduler {
  schedule(task: () => Promise<void> | void, delayMs: number): void;
  cancel(): void;
}
