import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { BridgeGatewayHostConfig, BridgeRuntimeOptions, ThirdPartyAgentProvider } from '../src/index.ts';
import { createBridgeRuntime } from '../src/index.ts';
import type {
  BridgeGatewayHostConnection,
  BridgeGatewayHostError,
  BridgeGatewayHostState,
  BridgeGatewayLogger,
} from '../src/application/gateway-host.ts';

type RecordedLog = {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
};

class RecordingLogger implements BridgeGatewayLogger {
  readonly logs: RecordedLog[] = [];

  debug(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'debug', message, meta });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'info', message, meta });
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'warn', message, meta });
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'error', message, meta });
  }
}

class FakeGatewayClient extends EventEmitter implements BridgeGatewayHostConnection {
  sent: unknown[] = [];
  state: BridgeGatewayHostState = 'DISCONNECTED';

  async connect(): Promise<void> {
    this.state = 'READY';
    this.emit('stateChange', this.state);
  }

  disconnect(): void {
    this.state = 'DISCONNECTED';
    this.emit('stateChange', this.state);
  }

  send(message: unknown): void {
    this.sent.push(message);
    this.emit('outbound', message);
  }

  isConnected(): boolean {
    return this.state === 'READY';
  }

  getState(): BridgeGatewayHostState {
    return this.state;
  }

  getStatus() {
    return {
      isReady: () => this.state === 'READY',
    };
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

  emitError(error: BridgeGatewayHostError): void {
    this.emit('error', error);
  }
}

function createProvider(): ThirdPartyAgentProvider {
  return {
    async health() {
      return { online: true };
    },
    async createSession() {
      return { toolSessionId: 'tool-1' };
    },
    async runMessage() {
      return {
        runId: 'run-1',
        facts: (async function* () {
          yield { type: 'message.start', toolSessionId: 'tool-1', messageId: 'msg-1' } as const;
          yield { type: 'message.done', toolSessionId: 'tool-1', messageId: 'msg-1' } as const;
        })(),
        async result() {
          return { outcome: 'completed' as const };
        },
      };
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

function createGatewayConfig(): BridgeGatewayHostConfig {
  return {
    url: 'ws://gateway.local',
    auth: {
      ak: 'ak',
      sk: 'sk',
    },
    register: {
      toolType: 'openx',
      toolVersion: '0.0.0',
      pluginVersion: '0.1.0',
    },
  };
}

function hasLog(logs: RecordedLog[], message: string, level?: RecordedLog['level']): boolean {
  return logs.some((log) => log.message === message && (!level || log.level === level));
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type RuntimeTestOptions = BridgeRuntimeOptions & {
  connectionFactory: () => BridgeGatewayHostConnection;
};

test('runtime projects observation events into lifecycle and command logs', async () => {
  const connection = new FakeGatewayClient();
  const logger = new RecordingLogger();
  const runtime = await createBridgeRuntime({
    provider: createProvider(),
    gatewayHost: createGatewayConfig(),
    logger,
    traceIdFactory: () => 'trace-fixed',
    connectionFactory: () => connection,
  } as RuntimeTestOptions);

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.equal(hasLog(logger.logs, 'runtime_sdk.start.requested', 'info'), true);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.gateway.state_changed', 'info'), true);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.downstream.received', 'info'), true);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.command.dispatched', 'info'), true);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.provider.startRequestRun.succeeded', 'info'), true);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.terminal.projected', 'info'), true);
});

test('runtime logs invalid invoke rejection and gateway failures through observation adapter', async () => {
  const connection = new FakeGatewayClient();
  const logger = new RecordingLogger();
  const runtime = await createBridgeRuntime({
    provider: createProvider(),
    gatewayHost: createGatewayConfig(),
    logger,
    connectionFactory: () => connection,
  } as RuntimeTestOptions);

  await runtime.start();
  connection.emitInbound({
    kind: 'invalid',
    messageType: 'invoke',
    welinkSessionId: 'welink-1',
    toolSessionId: 'tool-1',
    violation: {
      violation: {
        code: 'missing_required_field',
        message: 'payload.text is required',
      },
    },
  });
  connection.emitError({
    code: 'gateway_disconnected',
    message: 'gateway disconnected',
    retryable: false,
  });
  await flushEvents();

  assert.equal(hasLog(logger.logs, 'runtime_sdk.downstream.invalid_invoke_rejected', 'warn'), true);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.failure.recorded', 'error'), true);
});
