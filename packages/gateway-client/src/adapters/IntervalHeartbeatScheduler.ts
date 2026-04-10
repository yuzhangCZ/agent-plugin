import type { HeartbeatScheduler } from '../ports/HeartbeatScheduler.ts';

/**
 * 基于 `setInterval` 的心跳调度实现。
 */
export class IntervalHeartbeatScheduler implements HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(task: () => void, intervalMs: number): void {
    this.stop();
    this.timer = setInterval(task, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
