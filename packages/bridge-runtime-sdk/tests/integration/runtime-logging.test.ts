import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import { GatewayClientError, GatewayClientStatus } from '@agent-plugin/gateway-client';
import type { GatewayUplinkBusinessMessage } from '@agent-plugin/gateway-schema';
import type { BridgeGatewayHostConfig, BridgeRuntimeOptions, ThirdPartyAgentProvider } from '@/index.ts';
import { createBridgeRuntime } from '@/index.ts';
import { GatewayOutboundSinkAdapter } from '@/adapters/gateway/GatewayOutboundSinkAdapter.ts';
import { BridgeGatewayLoggerObservationAdapter } from '@/adapters/observation/runtime-logger-observation.ts';
import type { GatewayRuntimeDriver } from '@/application/ports/gateway-runtime-driver.ts';
import { DefaultRuntimeObservation } from '@/application/runtime-observation/index.ts';
import type {
  BridgeGatewayHostConnection,
  BridgeGatewayLogger,
} from '@/infrastructure/gateway/gateway-host.ts';

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
  state: 'DISCONNECTED' | 'READY' = 'DISCONNECTED';

  async connect(): Promise<void> {
    this.state = 'READY';
    this.emitStatus();
  }

  async disconnect(): Promise<void> {
    this.state = 'DISCONNECTED';
    this.emitStatus();
  }

  send(message: unknown): void {
    this.sent.push(message);
    this.emit('outbound', message);
  }

  isConnected(): boolean {
    return this.state === 'READY';
  }

  getStatus() {
    return this.state === 'READY'
      ? GatewayClientStatus.ready()
      : GatewayClientStatus.closed();
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

  emitStatus(): void {
    this.emit('statusChange', this.getStatus());
  }

  emitClosed(code: string, message?: string): void {
    this.state = 'DISCONNECTED';
    this.emit('statusChange', GatewayClientStatus.closed(new GatewayClientError({
      code: code as GatewayClientError['code'],
      disposition: 'runtime_failure',
      retryable: false,
      message: message ?? code,
    })));
  }

  emitError(error: { code: string; message?: string }): void {
    this.emitClosed(error.code, error.message);
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
          yield { type: 'message.start', messageId: 'msg-1' } as const;
          yield { type: 'message.done', messageId: 'msg-1' } as const;
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
      channel: 'openx',
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

function createRecordingGatewayDriver(): GatewayRuntimeDriver & { sent: GatewayUplinkBusinessMessage[] } {
  return {
    sent: [],
    attach() {},
    async connect() {},
    async disconnect() {},
    getStatus() {
      return GatewayClientStatus.ready();
    },
    send(message) {
      this.sent.push(message);
    },
    isReady() {
      return true;
    },
  };
}

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

test('runtime logs invalid tool_event validation with event type and field before gateway send', () => {
  const logger = new RecordingLogger();
  const driver = createRecordingGatewayDriver();
  const observation = new DefaultRuntimeObservation(new BridgeGatewayLoggerObservationAdapter(logger));
  const sink = new GatewayOutboundSinkAdapter(driver, observation);

  sink.send({
    type: 'tool_event',
    toolSessionId: 'tool-invalid-event',
    event: {
      type: 'session.status',
      properties: {},
    },
  } as GatewayUplinkBusinessMessage);

  const validationLog = logger.logs.find((log) => log.message === 'runtime_sdk.uplink.validation_failed');
  assert.equal(validationLog?.level, 'warn');
  assert.equal(validationLog?.meta?.messageType, 'tool_event');
  assert.equal(validationLog?.meta?.eventType, 'session.status');
  assert.equal(validationLog?.meta?.field, 'properties.sessionID');
  assert.equal(validationLog?.meta?.code, 'missing_required_field');
  assert.equal(validationLog?.meta?.toolSessionId, 'tool-invalid-event');
  assert.equal(driver.sent.length, 0);
});
