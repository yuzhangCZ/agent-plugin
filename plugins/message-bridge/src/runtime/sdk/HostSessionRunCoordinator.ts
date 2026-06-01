import type { BridgeLogger } from '../AppLogger.js';
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

  constructor(private readonly logger?: BridgeLogger) {}

  enqueue(handle: ActiveProviderRunHandle, work: () => Promise<void>): void {
    const queue = this.hostQueues.get(handle.hostSessionId) ?? [];
    queue.push({ handle, work });
    this.hostQueues.set(handle.hostSessionId, queue);
    this.logDebug('provider_adapter.run_queue.enqueued', handle, {
      queueLength: queue.length,
    });
    void this.drain(handle.hostSessionId);
  }

  private async drain(hostSessionId: string): Promise<void> {
    if (this.drainingHosts.has(hostSessionId)) {
      this.logger?.debug?.('provider_adapter.run_queue.drain_skipped', {
        hostSessionId,
        reason: 'already_draining',
        queueLength: this.hostQueues.get(hostSessionId)?.length ?? 0,
      });
      return;
    }

    this.drainingHosts.add(hostSessionId);
    this.logger?.debug?.('provider_adapter.run_queue.drain_started', {
      hostSessionId,
      queueLength: this.hostQueues.get(hostSessionId)?.length ?? 0,
    });
    try {
      await this.drainQueuedTasks(hostSessionId);
    } finally {
      this.drainingHosts.delete(hostSessionId);
      this.logger?.debug?.('provider_adapter.run_queue.drain_finished', {
        hostSessionId,
        remainingQueueLength: this.hostQueues.get(hostSessionId)?.length ?? 0,
      });
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
      this.logDebug('provider_adapter.run_queue.prompt_started', task.handle);
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
      this.logger?.error?.('provider_adapter.run_queue.prompt_task_failed', {
        hostSessionId: task.handle.hostSessionId,
        anchorSessionId: task.handle.anchorSessionId,
        runId: task.handle.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      task.handle.forceFailAndClose({
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      task.handle.markPromptTaskFinished();
    }
  }

  private closeUnexpectedStartableTask(handle: ActiveProviderRunHandle): void {
    this.logDebug('provider_adapter.run_queue.prompt_start_skipped', handle, {
      canStartPrompt: handle.canStartPrompt(),
    });
    if (handle.canStartPrompt()) {
      handle.forceAbortAndClose('abort_session');
    }
  }

  private shiftProcessedTask(hostSessionId: string, queue: HostSessionRunTask[]): void {
    queue.shift();
    this.logger?.debug?.('provider_adapter.run_queue.shifted', {
      hostSessionId,
      remainingQueueLength: queue.length,
    });
    if (queue.length === 0) {
      this.hostQueues.delete(hostSessionId);
    }
  }

  private restartIfTasksArrived(hostSessionId: string): void {
    if ((this.hostQueues.get(hostSessionId)?.length ?? 0) > 0) {
      void this.drain(hostSessionId);
    }
  }

  private logDebug(message: string, handle: ActiveProviderRunHandle, extra?: Record<string, unknown>): void {
    this.logger?.debug?.(message, {
      hostSessionId: handle.hostSessionId,
      anchorSessionId: handle.anchorSessionId,
      runId: handle.runId,
      ...(extra ?? {}),
    });
  }
}
