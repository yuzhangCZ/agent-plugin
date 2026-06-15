import { EventEmitter } from 'node:events';

import type { GatewayClient } from '../ports/GatewayClient.ts';
import type { GatewayClientEvents } from '../ports/GatewayClientEvents.ts';
import type { GatewayClientOptions } from '../ports/GatewayClientOptions.ts';
import type { GatewaySendPayload } from '../ports/GatewayClientMessages.ts';
import type { GatewaySendContext } from '../domain/send-context.ts';
import type { GatewayClientStatus } from '../domain/state.ts';
import { GatewayClientRuntime, type GatewayClientRuntimeDependencies } from './GatewayClientRuntime.ts';
import {
  guardGatewayClientOperation,
  toUnknownGatewayClientError,
} from './GatewayClientErrorBoundary.ts';

/**
 * 默认 facade 实现。
 * @remarks 对外暴露 API，并将 runtime 决策桥接为事件。
 */
export class DefaultGatewayClient extends EventEmitter implements GatewayClient {
  private readonly options: GatewayClientOptions;
  private readonly runtime: GatewayClientRuntime;

  constructor(options: GatewayClientOptions, dependencies: GatewayClientRuntimeDependencies) {
    super();
    this.options = options;
    this.runtime = new GatewayClientRuntime(options, dependencies, {
      emitStatusChange: (status) => this.safeEmit('statusChange', status),
      emitInbound: (message) => this.safeEmit('inbound', message),
      emitOutbound: (message) => this.safeEmit('outbound', message),
      emitHeartbeat: (message) => this.safeEmit('heartbeat', message),
      emitMessage: (message) => this.safeEmit('message', message),
    });
  }

  override on<E extends keyof GatewayClientEvents>(event: E, listener: GatewayClientEvents[E]): this {
    return super.on(event, listener);
  }

  async connect(): Promise<void> {
    await guardGatewayClientOperation(
      'connect',
      'startup_failure',
      () => this.runtime.connect(),
    );
  }

  async disconnect(): Promise<void> {
    await guardGatewayClientOperation(
      'disconnect',
      'diagnostic',
      () => this.runtime.disconnect(),
    );
  }

  send(message: GatewaySendPayload, logContext?: GatewaySendContext): void {
    guardGatewayClientOperation(
      'send',
      'diagnostic',
      () => this.runtime.send(message, logContext),
    );
  }

  isConnected(): boolean {
    return this.runtime.isConnected();
  }

  getStatus(): GatewayClientStatus {
    return this.runtime.getStatus();
  }

  private safeEmit<E extends keyof GatewayClientEvents>(
    event: E,
    ...args: Parameters<GatewayClientEvents[E]>
  ): void {
    for (const listener of this.listeners(event)) {
      try {
        (listener as (...listenerArgs: unknown[]) => void)(...args);
      } catch (error) {
        const clientError = toUnknownGatewayClientError(error, `event:${String(event)}`, 'diagnostic');
        try {
          this.options.logger?.error?.('gateway.event.listener_failed', {
            error: clientError.message,
            code: clientError.code,
            disposition: clientError.disposition,
            retryable: clientError.retryable,
          });
        } catch {
          // listener 异常已被隔离；日志失败不能反向影响 gateway lifecycle。
        }
      }
    }
  }
}
