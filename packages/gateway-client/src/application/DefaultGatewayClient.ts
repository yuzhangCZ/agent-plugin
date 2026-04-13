import { EventEmitter } from 'node:events';

import type { GatewayClient } from '../ports/GatewayClient.ts';
import type { GatewayClientEvents } from '../ports/GatewayClientEvents.ts';
import type { GatewayClientOptions } from '../ports/GatewayClientOptions.ts';
import type { GatewaySendPayload } from '../ports/GatewayClientMessages.ts';
import type { GatewaySendContext } from '../domain/send-context.ts';
import {
  createGatewayClientStatus,
  type GatewayClientState,
  type GatewayClientStatus,
} from '../domain/state.ts';
import { GatewayClientRuntime, type GatewayClientRuntimeDependencies } from './GatewayClientRuntime.ts';

/**
 * 默认 facade 实现。
 * @remarks 对外暴露 API，并将 runtime 决策桥接为事件。
 */
export class DefaultGatewayClient extends EventEmitter implements GatewayClient {
  private readonly runtime: GatewayClientRuntime;

  constructor(options: GatewayClientOptions, dependencies: GatewayClientRuntimeDependencies) {
    super();
    this.runtime = new GatewayClientRuntime(options, dependencies, {
      emitStateChange: (state) => this.emit('stateChange', state),
      emitInbound: (message) => this.emit('inbound', message),
      emitOutbound: (message) => this.emit('outbound', message),
      emitHeartbeat: (message) => this.emit('heartbeat', message),
      emitMessage: (message) => this.emit('message', message),
      emitError: (error) => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', error);
        }
      },
    });
    this.runtime.setReconnectInvoker(() => this.connect());
  }

  override on<E extends keyof GatewayClientEvents>(event: E, listener: GatewayClientEvents[E]): this {
    return super.on(event, listener);
  }

  connect(): Promise<void> {
    return this.runtime.connect();
  }

  disconnect(): void {
    this.runtime.disconnect();
  }

  send(message: GatewaySendPayload, logContext?: GatewaySendContext): void {
    this.runtime.send(message, logContext);
  }

  isConnected(): boolean {
    return this.runtime.isConnected();
  }

  getState(): GatewayClientState {
    return this.runtime.getState();
  }

  getStatus(): GatewayClientStatus {
    return createGatewayClientStatus(this.getState());
  }
}
