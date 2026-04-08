// HeartbeatScheduler 统一管理心跳计时器，避免 runtime 直接依赖全局 timer API。
export interface HeartbeatScheduler {
  start(task: () => void, intervalMs: number): void;
  stop(): void;
}
