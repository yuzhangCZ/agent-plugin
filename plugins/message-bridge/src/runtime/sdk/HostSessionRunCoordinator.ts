import type { ActiveProviderRunHandle } from './OpenCodeProviderAdapter.run.js';

type HostSessionRunTask = {
  handle: ActiveProviderRunHandle;
  work: () => Promise<void>;
};

/**
 * 同一宿主 session 下的 provider run prompt 调度器。
 * @remarks
 * registry 只维护 active run 索引和事件路由队首；这里负责按 host session FIFO 串行启动 prompt，
 * 并等 run 的 prompt terminal 与 facts drain 都完成后再释放下一个 queued run。
 */
export class HostSessionRunCoordinator {
  private readonly hostQueues = new Map<string, HostSessionRunTask[]>();
  private readonly drainingHosts = new Set<string>();

  enqueue(handle: ActiveProviderRunHandle, work: () => Promise<void>): void {
    const queue = this.hostQueues.get(handle.hostSessionId) ?? [];
    queue.push({ handle, work });
    this.hostQueues.set(handle.hostSessionId, queue);
    void this.drain(handle.hostSessionId);
  }

  private async drain(hostSessionId: string): Promise<void> {
    if (this.drainingHosts.has(hostSessionId)) {
      return;
    }

    this.drainingHosts.add(hostSessionId);
    try {
      await this.drainQueuedTasks(hostSessionId);
    } finally {
      this.drainingHosts.delete(hostSessionId);
      this.restartIfTasksArrived(hostSessionId);
    }
  }

  private async drainQueuedTasks(hostSessionId: string): Promise<void> {
    while (await this.processNextTask(hostSessionId)) {
      // Keep draining this host session until its queue is empty.
    }
  }

  private async processNextTask(hostSessionId: string): Promise<boolean> {
    const queue = this.hostQueues.get(hostSessionId);
    const task = queue?.[0];
    if (!queue || !task) {
      this.hostQueues.delete(hostSessionId);
      return false;
    }

    try {
      await this.runTask(task);
    } finally {
      this.shiftProcessedTask(hostSessionId, queue);
    }
    return true;
  }

  private async runTask(task: HostSessionRunTask): Promise<void> {
    if (task.handle.tryStartPrompt()) {
      await this.runStartedPromptTask(task);
    } else {
      this.closeUnexpectedStartableTask(task.handle);
    }
    await task.handle.result();
  }

  private async runStartedPromptTask(task: HostSessionRunTask): Promise<void> {
    try {
      await task.work();
    } catch (error) {
      task.handle.forceFailAndClose({
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      task.handle.markPromptTaskFinished();
    }
  }

  private closeUnexpectedStartableTask(handle: ActiveProviderRunHandle): void {
    if (handle.canStartPrompt()) {
      handle.forceAbortAndClose('abort_session');
    }
  }

  private shiftProcessedTask(hostSessionId: string, queue: HostSessionRunTask[]): void {
    queue.shift();
    if (queue.length === 0) {
      this.hostQueues.delete(hostSessionId);
    }
  }

  private restartIfTasksArrived(hostSessionId: string): void {
    if ((this.hostQueues.get(hostSessionId)?.length ?? 0) > 0) {
      void this.drain(hostSessionId);
    }
  }
}
