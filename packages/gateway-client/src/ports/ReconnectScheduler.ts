/**
 * 重连调度端口。
 * @remarks 统一承载 schedule/cancel，避免重连逻辑与计时器实现耦合。
 */
export interface ReconnectScheduler {
  schedule(task: () => Promise<void> | void, delayMs: number): void;
  cancel(): void;
}
