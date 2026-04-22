import type { ReconnectScheduler } from '../ports/ReconnectScheduler.ts';

/**
 * 基于 `setTimeout` 的重连调度实现。
 */
export class TimeoutReconnectScheduler implements ReconnectScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;

  schedule(task: () => Promise<void> | void, delayMs: number): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      void task();
    }, delayMs);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
