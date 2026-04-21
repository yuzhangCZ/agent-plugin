import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  GatewayClient,
  GatewayClientConfig,
  GatewayClientErrorShape,
  GatewayClientState,
} from '@agent-plugin/gateway-client';

import { createBridgeRuntime } from '../src/index.ts';
import type {
  BridgeRuntimeOptions,
  ProviderFact,
  ProviderRun,
  ProviderTerminalResult,
  ThirdPartyAgentProvider,
} from '../src/index.ts';

function createAsyncFacts(facts: ProviderFact[]): AsyncIterable<ProviderFact> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const fact of facts) {
        yield fact;
      }
    },
  };
}

function createFakeRun(facts: ProviderFact[], result: ProviderTerminalResult): ProviderRun {
  return {
    runId: 'run-1',
    facts: createAsyncFacts(facts),
    async result() {
      return result;
    },
  };
}

class FakeGatewayClient extends EventEmitter implements GatewayClient {
  sent: unknown[] = [];
  state: GatewayClientState = 'DISCONNECTED';
  connectError: Error | null = null;

  async connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    if (this.connectError) {
      throw this.connectError;
    }
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
    return this.state === 'CONNECTED' || this.state === 'READY';
  }

  getState(): GatewayClientState {
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

  emitHeartbeat(message: unknown): void {
    this.emit('heartbeat', message);
  }

  emitError(error: GatewayClientErrorShape): void {
    this.emit('error', error);
  }
}

function createRuntimeOptions(
  provider: ThirdPartyAgentProvider,
  connection: FakeGatewayClient,
  extra?: Partial<BridgeRuntimeOptions>,
): BridgeRuntimeOptions {
  return {
    provider,
    gateway: {
      url: 'ws://gateway.local',
      registerMessage: {
        type: 'register',
        mac: '00:00:00:00:00:00',
        os: 'darwin',
        toolType: 'openclaw',
        toolVersion: '0.0.0',
        deviceName: 'runtime-test',
      },
    } satisfies GatewayClientConfig,
    connectionFactory: () => connection,
    traceIdFactory: () => 'trace-fixed',
    ...extra,
  };
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function createInvalidInvokeInboundFrame() {
  return {
    kind: 'invalid',
    messageType: 'invoke',
    gatewayMessageId: 'gw-invalid-1',
    action: 'chat',
    welinkSessionId: 'wl-invalid-1',
    toolSessionId: 'tool-invalid-1',
    violation: {
      violation: {
        stage: 'payload',
        code: 'missing_required_field',
        field: 'payload.text',
        message: 'payload.text is required',
        messageType: 'invoke',
        action: 'chat',
        welinkSessionId: 'wl-invalid-1',
        toolSessionId: 'tool-invalid-1',
      },
    },
    rawPreview: {
      type: 'invoke',
      messageId: 'gw-invalid-1',
      action: 'chat',
      welinkSessionId: 'wl-invalid-1',
      payload: {
        toolSessionId: 'tool-invalid-1',
      },
    },
  };
}

test('runtime starts, consumes downstream messages from gateway-client, and projects uplinks', async () => {
  const connection = new FakeGatewayClient();
  const provider: ThirdPartyAgentProvider = {
    async health() {
      return { online: true };
    },
    async createSession() {
      return { toolSessionId: 'tool-1' };
    },
    async runMessage() {
      return createFakeRun(
        [
          { type: 'message.start', toolSessionId: 'tool-1', messageId: 'msg-1' },
          { type: 'text.delta', toolSessionId: 'tool-1', messageId: 'msg-1', partId: 'part-1', content: 'he' },
          { type: 'text.done', toolSessionId: 'tool-1', messageId: 'msg-1', partId: 'part-1', content: 'hello' },
          { type: 'message.done', toolSessionId: 'tool-1', messageId: 'msg-1' },
        ],
        { outcome: 'completed' },
      );
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

  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  assert.deepEqual(runtime.getStatus(), {
    state: 'ready',
    failureReason: null,
  });

  connection.emitMessage({
    type: 'invoke',
    action: 'create_session',
    welinkSessionId: 'welink-1',
    payload: { title: 'demo' },
  });
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent[0], {
    type: 'session_created',
    welinkSessionId: 'welink-1',
    toolSessionId: 'tool-1',
    session: { sessionId: 'tool-1' },
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_done',
    toolSessionId: 'tool-1',
    welinkSessionId: 'welink-1',
  });
  assert.equal(
    connection.sent.some(
      (message) => typeof message === 'object' && message !== null && 'type' in message && message.type === 'tool_event',
    ),
    true,
  );

  await runtime.stop();
  assert.deepEqual(runtime.getStatus(), {
    state: 'idle',
    failureReason: null,
  });
});

test('runtime start rejects and enters failed when provider initialize fails', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async initialize() {
          throw new Error('provider_init_failed');
        },
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
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
      },
      connection,
    ),
  );

  await assert.rejects(runtime.start(), /provider_init_failed/);
  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'provider_init_failed',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'startup_failure',
    phase: 'start',
    message: 'provider_init_failed',
    code: undefined,
  });
});

test('runtime reflects reconnecting and returns to ready after gateway reconnects', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
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
      },
      connection,
    ),
  );

  await runtime.start();
  connection.disconnect();
  assert.equal(runtime.getStatus().state, 'reconnecting');

  await connection.connect();
  assert.deepEqual(runtime.getStatus(), {
    state: 'ready',
    failureReason: null,
  });
});

test('request-level command failures stay ready and record command_execution_failure', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage() {
          throw new Error('run_failed');
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
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'command_execution_failure',
    phase: 'runtime',
    message: 'run_failed',
    code: undefined,
  });
  assert.equal(runtime.getStatus().failureReason, null);
});

test('invalid downstream messages stay ready and record inbound_validation_failure', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
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
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'unsupported_action',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'inbound_validation_failure',
    phase: 'runtime',
    message: 'Unsupported downstream action: unsupported_action',
    code: undefined,
  });
  assert.equal(runtime.getStatus().failureReason, null);
});

test('runtime handles invalid invoke inbound frames and records transport diagnostics', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
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
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitInbound(createInvalidInvokeInboundFrame());
  connection.emitHeartbeat({ type: 'heartbeat' });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    welinkSessionId: 'wl-invalid-1',
    toolSessionId: 'tool-invalid-1',
    error: 'gateway_invalid_invoke:missing_required_field',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'inbound_validation_failure',
    phase: 'runtime',
    message: 'payload.text is required',
    code: 'missing_required_field',
  });
  assert.equal(runtime.getDiagnostics().gatewayState, 'READY');
  assert.equal(typeof runtime.getDiagnostics().lastInboundAt, 'number');
  assert.equal(typeof runtime.getDiagnostics().lastOutboundAt, 'number');
  assert.equal(typeof runtime.getDiagnostics().lastHeartbeatAt, 'number');
  assert.equal(runtime.getStatus().failureReason, null);
});

test('invalid outbound messages stay ready and record outbound_validation_failure', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage() {
          return createFakeRun(
            [{ type: 'text.delta', toolSessionId: 'tool-1', messageId: 'msg-1', partId: 'part-1', content: 'bad' }],
            { outcome: 'completed' },
          );
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
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'text.delta requires an open message',
    code: 'fact_sequence_invalid',
  });
  assert.equal(runtime.getStatus().failureReason, null);
});

test('runtime marks non-retryable gateway errors as failed', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
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
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitError({
    code: 'GATEWAY_REGISTER_REJECTED',
    category: 'auth',
    retryable: false,
    message: 'rejected',
  });
  await flushEvents();

  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'rejected',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'gateway_runtime_failure',
    phase: 'runtime',
    message: 'rejected',
    code: 'GATEWAY_REGISTER_REJECTED',
  });
});
