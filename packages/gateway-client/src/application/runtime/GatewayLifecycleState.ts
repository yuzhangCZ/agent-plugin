import { GatewayClientStatus } from '../../domain/state.ts';
import type { GatewayClientError } from '../../errors/GatewayClientError.ts';
import { GatewayClientError as GatewayClientErrorImpl } from '../../errors/GatewayClientError.ts';

export interface GatewayLifecycleSessionToken {
  generation: number;
  sessionId: number;
}

interface GatewayLifecycleStateOptions {
  emitStatusChange(status: GatewayClientStatus): void;
}

/**
 * gateway-client 内部连接生命周期状态模型。
 * @remarks 作为唯一状态写入口，用 generation/session 防止迟到异步回调覆盖更新的用户意图。
 */
export class GatewayLifecycleState {
  private readonly options: GatewayLifecycleStateOptions;
  private status = GatewayClientStatus.closed();
  private lifecycleGeneration = 0;
  private nextSessionId = 0;
  private activeSessionId: number | null = null;
  private manuallyDisconnected = false;

  constructor(options: GatewayLifecycleStateOptions) {
    this.options = options;
  }

  getStatus(): GatewayClientStatus {
    return this.status;
  }

  isReady(): boolean {
    return this.status.isReady();
  }

  isManuallyDisconnected(): boolean {
    return this.manuallyDisconnected;
  }

  getGeneration(): number {
    return this.lifecycleGeneration;
  }

  isCurrentGeneration(generation: number): boolean {
    return this.lifecycleGeneration === generation;
  }

  beginConnect(input: { reconnectAttempt: boolean }): GatewayLifecycleSessionToken {
    this.manuallyDisconnected = false;
    const token = {
      generation: this.lifecycleGeneration,
      sessionId: ++this.nextSessionId,
    };
    this.activeSessionId = token.sessionId;
    this.transitionStatus(input.reconnectAttempt ? GatewayClientStatus.reconnecting() : GatewayClientStatus.connecting());
    return token;
  }

  finishConnectIfCurrent(token: GatewayLifecycleSessionToken): boolean {
    if (!this.isCurrentSession(token)) {
      return false;
    }
    this.transitionStatus(GatewayClientStatus.ready());
    return true;
  }

  markReconnectingIfCurrent(token: GatewayLifecycleSessionToken): boolean {
    if (!this.isCurrentSession(token)) {
      return false;
    }
    this.transitionStatus(GatewayClientStatus.reconnecting());
    return true;
  }

  beginReconnectWindow(): number {
    const generation = this.lifecycleGeneration;
    if (!this.manuallyDisconnected) {
      this.transitionStatus(GatewayClientStatus.reconnecting());
    }
    return generation;
  }

  closeReconnectExhaustedIfCurrent(generation: number): boolean {
    if (!this.isCurrentGeneration(generation)) {
      return false;
    }
    this.activeSessionId = null;
    this.transitionStatus(GatewayClientStatus.closed(new GatewayClientErrorImpl({
      code: 'GATEWAY_RECONNECT_EXHAUSTED',
      disposition: 'runtime_failure',
      retryable: false,
      message: 'gateway_reconnect_exhausted',
    })));
    return true;
  }

  closeIfCurrent(token: GatewayLifecycleSessionToken, error: GatewayClientError): boolean {
    if (!this.isCurrentSession(token)) {
      return false;
    }
    this.activeSessionId = null;
    this.transitionStatus(GatewayClientStatus.closed(error));
    return true;
  }

  closeManual(): void {
    this.manuallyDisconnected = true;
    this.lifecycleGeneration += 1;
    this.activeSessionId = null;
    this.transitionStatus(GatewayClientStatus.closed(new GatewayClientErrorImpl({
      code: 'GATEWAY_CLOSED_MANUAL',
      disposition: 'cancelled',
      retryable: false,
      message: 'gateway_closed_manual',
    })));
  }

  isCurrentSession(token: GatewayLifecycleSessionToken): boolean {
    return this.lifecycleGeneration === token.generation
      && this.activeSessionId === token.sessionId;
  }

  private transitionStatus(status: GatewayClientStatus): void {
    this.status = status;
    this.options.emitStatusChange(this.status);
  }
}
