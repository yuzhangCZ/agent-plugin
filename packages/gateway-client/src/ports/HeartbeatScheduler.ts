/**
 * 心跳调度端口。
 * @remarks 抽象 timer API，避免 runtime 直接依赖全局计时器。
 */
export interface HeartbeatScheduler {
  start(task: () => void, intervalMs: number): void;
  stop(): void;
}
