import { EventEmitter } from 'node:events';

import type { GatewayClient } from '../ports/GatewayClient.ts';
import type { GatewayClientEvents } from '../ports/GatewayClientEvents.ts';
import type { GatewayClientOptions } from '../ports/GatewayClientOptions.ts';
import type { GatewaySendContext } from '../domain/send-context.ts';
import type { GatewayClientState } from '../domain/state.ts';
import { GatewayClientRuntime, type GatewayClientRuntimeDependencies } from './GatewayClientRuntime.ts';

// DefaultGatewayClient 只承担 facade 职责：对外暴露 API，并把 runtime 决策桥接成事件。
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

  send(message: unknown, logContext?: GatewaySendContext): void {
    this.runtime.send(message, logContext);
  }

  isConnected(): boolean {
    return this.runtime.isConnected();
  }

  getState(): GatewayClientState {
    return this.runtime.getState();
  }
}
