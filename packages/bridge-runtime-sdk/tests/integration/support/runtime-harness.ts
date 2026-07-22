import { EventEmitter } from 'node:events';

import { GatewayClientError, GatewayClientStatus } from '@agent-plugin/gateway-client';
import type {
  BridgeGatewayHostConfig,
  BridgeRuntimeOptions,
  ProviderFact,
  ProviderRun,
  ProviderTerminalResult,
  ThirdPartyAgentProvider,
} from '@/index.ts';
import type { BridgeGatewayHostConnection } from '@/infrastructure/gateway/gateway-host.ts';

export function createAsyncFacts(facts: ProviderFact[]): AsyncIterable<ProviderFact> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const fact of facts) {
        yield fact;
      }
    },
  };
}

export function createFakeRun(facts: ProviderFact[], result: ProviderTerminalResult): ProviderRun {
  return {
    runId: 'run-1',
    facts: createAsyncFacts(facts),
    async result() {
      return result;
    },
  };
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

export function createHangingFacts(
  facts: ProviderFact[],
  release: Promise<unknown>,
): AsyncIterable<ProviderFact> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const fact of facts) {
        yield fact;
      }
      await release;
    },
  };
}

export class FakeGatewayClient extends EventEmitter implements BridgeGatewayHostConnection {
  sent: unknown[] = [];
  state: 'CONNECTED' | 'DISCONNECTED' | 'CONNECTING' | 'READY' = 'DISCONNECTED';
  connectError: Error | null = null;
  reconnecting = false;
  closedCode:
    | 'GATEWAY_AUTH_REJECTED'
    | 'GATEWAY_CLOSED_MANUAL'
    | 'GATEWAY_CONNECT_ABORTED'
    | 'GATEWAY_RECONNECT_EXHAUSTED'
    | 'GATEWAY_TRANSPORT_ERROR'
    | null = null;

  async connect(): Promise<void> {
    this.reconnecting = false;
    this.closedCode = null;
    this.state = 'CONNECTING';
    this.emitStatus();
    if (this.connectError) {
      throw this.connectError;
    }
    this.state = 'READY';
    this.emitStatus();
  }

  async disconnect(): Promise<void> {
    this.reconnecting = false;
    this.closedCode = 'GATEWAY_CLOSED_MANUAL';
    this.state = 'DISCONNECTED';
    this.emitStatus();
  }

  send(message: unknown): void {
    this.sent.push(message);
    this.emit('outbound', message);
  }

  isConnected(): boolean {
    return this.state === 'CONNECTED' || this.state === 'READY';
  }

  getStatus() {
    if (this.state === 'READY') {
      return GatewayClientStatus.ready();
    }
    if (this.reconnecting) {
      return GatewayClientStatus.reconnecting();
    }
    if (this.closedCode) {
      return GatewayClientStatus.closed(this.createClosedError(this.closedCode));
    }
    if (this.state === 'DISCONNECTED') {
      return GatewayClientStatus.closed();
    }
    return GatewayClientStatus.connecting();
  }

  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  emitMessage(message: unknown): void {
    this.emit('message', message);
  }

  emitInbound(frame: unknown): void {
    this.emit('inbound', frame);
  }

  emitHeartbeat(message: unknown): void {
    this.emit('heartbeat', message);
  }

  emitStatus(): void {
    this.emit('statusChange', this.getStatus());
  }

  emitClosed(code: string, message?: string): void {
    this.reconnecting = false;
    const closedCode = code as NonNullable<typeof this.closedCode>;
    this.closedCode = closedCode;
    this.state = 'DISCONNECTED';
    this.emit('statusChange', GatewayClientStatus.closed(this.createClosedError(closedCode, message)));
  }

  emitError(error: { code: string; message?: string }): void {
    this.emitClosed(error.code, error.message);
  }

  private createClosedError(code: NonNullable<typeof this.closedCode>, message?: string): GatewayClientError {
    return new GatewayClientError({
      code,
      disposition: code === 'GATEWAY_CLOSED_MANUAL' || code === 'GATEWAY_CONNECT_ABORTED'
        ? 'cancelled'
        : 'runtime_failure',
      retryable: false,
      message: message ?? code,
    });
  }
}

export function createRuntimeOptions(
  provider: ThirdPartyAgentProvider,
  connection: FakeGatewayClient,
  extra?: Partial<BridgeRuntimeOptions>,
): BridgeRuntimeOptions {
  return {
    provider,
    gatewayHost: {
      url: 'ws://gateway.local',
      auth: {
        ak: 'ak',
        sk: 'sk',
      },
      register: {
        channel: 'openx',
        toolVersion: '0.0.0',
        pluginVersion: '0.1.0',
      },
    } satisfies BridgeGatewayHostConfig,
    connectionFactory: () => connection,
    traceIdFactory: () => 'trace-fixed',
    ...extra,
  };
}

export function flushEvents(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export function createProvider(): ThirdPartyAgentProvider {
  return {
    async health() {
      return { online: true };
    },
    async createSession() {
      return { toolSessionId: 'tool-1' };
    },
    async listSlashCommands() {
      return { slashCommands: [] };
    },
    async runMessage() {
      return createFakeRun([], { outcome: 'completed' });
    },
    async replyQuestion() {
      return { applied: true };
    },
    async replyPermission() {
      return { applied: true };
    },
    async closeSession() {
      return { applied: true };
    },
    async abortSession() {
      return { applied: true };
    },
  };
}
