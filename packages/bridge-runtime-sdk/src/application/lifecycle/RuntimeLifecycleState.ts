import type { BridgeRuntimeStatus, BridgeRuntimeStatusSnapshot } from '../runtime.ts';

type RuntimeLifecycleAttemptId = number;

/**
 * Runtime lifecycle 内部状态模型。
 * @remarks 对外仍只暴露 plain snapshot；attempt id 用于阻止旧异步流程覆盖较新的停止或失败意图。
 */
export class RuntimeLifecycleState {
  private current: BridgeRuntimeStatusSnapshot = {
    state: 'idle',
    failureReason: null,
  };
  private nextToken = 0;
  private activeStartToken: number | null = null;
  private activeStopToken: number | null = null;

  snapshot(): BridgeRuntimeStatusSnapshot {
    return { ...this.current };
  }

  isIdle(): boolean {
    return this.current.state === 'idle';
  }

  isReady(): boolean {
    return this.current.state === 'ready';
  }

  isStarting(): boolean {
    return this.current.state === 'starting';
  }

  isStopping(): boolean {
    return this.current.state === 'stopping';
  }

  isFailed(): boolean {
    return this.current.state === 'failed';
  }

  shouldIgnoreGatewayStatus(): boolean {
    return this.isIdle() || this.isStopping() || this.isFailed();
  }

  beginStart(): RuntimeLifecycleAttemptId {
    const attemptId = this.createAttemptId();
    this.activeStartToken = attemptId;
    this.activeStopToken = null;
    this.setStatus('starting', null);
    return attemptId;
  }

  markReady(): void {
    this.setStatus('ready', null);
  }

  markReconnecting(): void {
    this.setStatus('reconnecting', null);
  }

  beginStop(): RuntimeLifecycleAttemptId {
    const attemptId = this.createAttemptId();
    this.activeStopToken = attemptId;
    this.activeStartToken = null;
    this.setStatus('stopping', null);
    return attemptId;
  }

  markIdle(): void {
    this.activeStopToken = null;
    this.setStatus('idle', null);
  }

  markFailed(reason: string): void {
    this.activeStartToken = null;
    this.activeStopToken = null;
    this.setStatus('failed', reason);
  }

  finishStartIfCurrent(attemptId: RuntimeLifecycleAttemptId): boolean {
    if (this.activeStartToken !== attemptId || this.isStopping() || this.isFailed()) {
      return false;
    }
    this.activeStartToken = null;
    this.markReady();
    return true;
  }

  failStartIfCurrent(attemptId: RuntimeLifecycleAttemptId, reason: string): boolean {
    if (this.activeStartToken !== attemptId) {
      return false;
    }
    this.markFailed(reason);
    return true;
  }

  finishStopIfCurrent(attemptId: RuntimeLifecycleAttemptId): boolean {
    if (this.activeStopToken !== attemptId || !this.isStopping()) {
      return false;
    }
    this.markIdle();
    return true;
  }

  private createAttemptId(): RuntimeLifecycleAttemptId {
    this.nextToken += 1;
    return this.nextToken;
  }

  private setStatus(state: BridgeRuntimeStatus, failureReason: string | null): void {
    this.current = {
      state,
      failureReason,
    };
  }
}
