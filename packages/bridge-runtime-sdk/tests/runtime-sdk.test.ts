import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  BridgeGatewayHostConfig,
  BridgeRuntimeOptions,
  ProviderFact,
  ProviderRun,
  ProviderTerminalResult,
  ThirdPartyAgentProvider,
} from '../src/index.ts';
import type {
  BridgeGatewayHostConnection,
  BridgeGatewayHostError,
  BridgeGatewayHostState,
} from '../src/application/gateway-host.ts';
import { createBridgeRuntime } from '../src/index.ts';

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

class FakeGatewayClient extends EventEmitter implements BridgeGatewayHostConnection {
  sent: unknown[] = [];
  state: BridgeGatewayHostState = 'DISCONNECTED';
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

  emitHeartbeat(message: unknown): void {
    this.emit('heartbeat', message);
  }

  emitError(error: BridgeGatewayHostError): void {
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
    gatewayHost: {
      url: 'ws://gateway.local',
      auth: {
        ak: 'ak',
        sk: 'sk',
      },
      register: {
        toolType: 'openx',
        toolVersion: '0.0.0',
      },
    } satisfies BridgeGatewayHostConfig,
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

function createProvider(): ThirdPartyAgentProvider {
  return {
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
  };
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

test('runtime start trusts gateway-client connect READY contract', async () => {
  const connection = new FakeGatewayClient();
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    await flushEvents();
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  assert.equal(runtime.getStatus().state, 'ready');
});

test('runtime start disconnects owned connection when startup fails after connection creation', async () => {
  const connection = new FakeGatewayClient();
  let disconnectCalls = 0;
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTED';
    this.emit('stateChange', this.state);
    throw new Error('connect_failed_after_open');
  };
  connection.disconnect = function disconnect(): void {
    disconnectCalls += 1;
    this.state = 'DISCONNECTED';
    this.emit('stateChange', this.state);
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await assert.rejects(runtime.start(), /connect_failed_after_open/);

  assert.equal(disconnectCalls, 1);
  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'connect_failed_after_open',
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

test('request run projects session.error exactly once before terminal tool_error', async () => {
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
            [
              {
                type: 'session.error',
                toolSessionId: 'tool-1',
                error: {
                  code: 'internal_error',
                  message: 'agent offline',
                },
              },
            ],
            {
              outcome: 'failed',
              error: {
                code: 'internal_error',
                message: 'agent offline',
              },
            },
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

  const sessionErrors = connection.sent.filter((message) =>
    typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'tool_event'
    && 'event' in message
    && typeof message.event === 'object'
    && message.event !== null
    && 'type' in message.event
    && message.event.type === 'session.error',
  );
  assert.equal(sessionErrors.length, 1);
  assert.deepEqual(sessionErrors[0], {
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      family: 'skill',
      type: 'session.error',
      properties: {
        error: 'agent offline',
      },
    },
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    welinkSessionId: 'welink-1',
    error: 'agent offline',
  });
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

test('probe passes the same public gatewayHost contract to connectionFactory as start', async () => {
  const configs: BridgeGatewayHostConfig[] = [];
  const runtimeConnection = new FakeGatewayClient();
  const probeConnection = new FakeGatewayClient();
  let factoryCalls = 0;
  const gatewayHost: BridgeGatewayHostConfig = {
    url: 'ws://gateway.local',
    auth: {
      ak: 'ak',
      sk: 'sk',
    },
    register: {
      toolType: 'openx',
      toolVersion: '0.0.0',
    },
  };
  const runtime = await createBridgeRuntime({
    ...createRuntimeOptions(createProvider(), runtimeConnection, {
      gatewayHost,
      connectionFactory: (config) => {
        configs.push(config);
        factoryCalls += 1;
        return factoryCalls === 1 ? runtimeConnection : probeConnection;
      },
    }),
  });

  await runtime.start();
  await runtime.stop();
  const result = await runtime.probe({ timeoutMs: 50 });

  assert.equal(result.state, 'ready');
  assert.equal(configs.length, 2);
  assert.deepEqual(configs[0], gatewayHost);
  assert.deepEqual(configs[1], gatewayHost);
  assert.deepEqual(Object.keys(configs[0]!), ['url', 'auth', 'register']);
  assert.deepEqual(Object.keys(configs[1]!), ['url', 'auth', 'register']);
});

test('failed start does not drift back to reconnecting or ready after later gateway events', async () => {
  const connection = new FakeGatewayClient();
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTED';
    this.emit('stateChange', this.state);
    throw new Error('connect_failed_after_open');
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await assert.rejects(runtime.start(), /connect_failed_after_open/);
  connection.emit('stateChange', 'READY');
  connection.emit('stateChange', 'DISCONNECTED');

  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'connect_failed_after_open',
  });
});

test('runtime diagnostics record lastReadyAt when gateway becomes ready', async () => {
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

  assert.equal(typeof runtime.getDiagnostics().lastReadyAt, 'number');
});

test('runtime probe short-circuits when same gateway url and ak runtime is ready', async () => {
  const runtimeConnection = new FakeGatewayClient();
  const probeConnection = new FakeGatewayClient();
  let probeConnectionAttempts = 0;
  const gatewayHost = {
    url: 'ws://gateway.local',
    auth: {
      ak: 'shared-ak',
      sk: 'shared-sk',
    },
    register: {
      toolType: 'openx',
      toolVersion: '0.0.0',
    },
  } satisfies BridgeGatewayHostConfig;
  const runtime = await createBridgeRuntime({
    provider: {
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
    gatewayHost,
    connectionFactory: () => runtimeConnection,
  });

  await runtime.start();

  const result = await runtime.probe({ timeoutMs: 50 });

  assert.deepEqual(result.state, 'ready');
  assert.equal(probeConnectionAttempts, 0);
});

test('different runtimes with the same gateway url and ak own separate connections', async () => {
  const firstConnection = new FakeGatewayClient();
  const secondConnection = new FakeGatewayClient();
  let firstConnectCalls = 0;
  let secondConnectCalls = 0;
  firstConnection.connect = async function connect(): Promise<void> {
    firstConnectCalls += 1;
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    await flushEvents();
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };
  secondConnection.connect = async function connect(): Promise<void> {
    secondConnectCalls += 1;
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    await flushEvents();
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };

  const provider: ThirdPartyAgentProvider = {
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
  };

  const firstRuntime = await createBridgeRuntime(
    createRuntimeOptions(provider, firstConnection, {
      gatewayHost: {
        url: 'ws://gateway.local',
        auth: {
          ak: 'shared-ak',
          sk: 'shared-sk',
        },
        register: {
          toolType: 'openx',
          toolVersion: '0.0.0',
        },
      },
      connectionFactory: () => firstConnection,
    }),
  );
  const secondRuntime = await createBridgeRuntime(
    createRuntimeOptions(provider, secondConnection, {
      gatewayHost: {
        url: 'ws://gateway.local',
        auth: {
          ak: 'shared-ak',
          sk: 'shared-sk',
        },
        register: {
          toolType: 'openx',
          toolVersion: '0.0.0',
        },
      },
      connectionFactory: () => secondConnection,
    }),
  );

  await Promise.all([firstRuntime.start(), secondRuntime.start()]);

  assert.equal(firstConnectCalls, 1);
  assert.equal(secondConnectCalls, 1);
  assert.equal(firstRuntime.getStatus().state, 'ready');
  assert.equal(secondRuntime.getStatus().state, 'ready');
});

test('concurrent start on one runtime creates and connects once', async () => {
  const connection = new FakeGatewayClient();
  let factoryCalls = 0;
  let connectCalls = 0;
  connection.connect = async function connect(): Promise<void> {
    connectCalls += 1;
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    await flushEvents();
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), connection, {
      connectionFactory: () => {
        factoryCalls += 1;
        return connection;
      },
    }),
  );

  await Promise.all([runtime.start(), runtime.start()]);

  assert.equal(factoryCalls, 1);
  assert.equal(connectCalls, 1);
  assert.equal(runtime.getStatus().state, 'ready');
});

test('concurrent probe on one runtime creates one temporary connection', async () => {
  const connection = new FakeGatewayClient();
  let factoryCalls = 0;
  let connectCalls = 0;
  connection.connect = async function connect(): Promise<void> {
    connectCalls += 1;
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    await flushEvents();
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), connection, {
      connectionFactory: () => {
        factoryCalls += 1;
        return connection;
      },
    }),
  );

  const [first, second] = await Promise.all([
    runtime.probe({ timeoutMs: 50 }),
    runtime.probe({ timeoutMs: 50 }),
  ]);

  assert.equal(factoryCalls, 1);
  assert.equal(connectCalls, 1);
  assert.equal(first.state, 'ready');
  assert.deepEqual(second, first);
});

test('start cancels in-flight probe before creating runtime connection', async () => {
  const probeConnection = new FakeGatewayClient();
  const runtimeConnection = new FakeGatewayClient();
  const createdConnections: string[] = [];
  let runtimeConnectCalls = 0;
  probeConnection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
  };
  runtimeConnection.connect = async function connect(): Promise<void> {
    runtimeConnectCalls += 1;
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), runtimeConnection, {
      connectionFactory: () => {
        if (createdConnections.length === 0) {
          createdConnections.push('probe');
          return probeConnection;
        }
        createdConnections.push('runtime');
        return runtimeConnection;
      },
    }),
  );

  const probe = runtime.probe({ timeoutMs: 5_000 });
  await flushEvents();
  await runtime.start();
  const probeResult = await probe;

  assert.deepEqual(createdConnections, ['probe', 'runtime']);
  assert.equal(probeResult.state, 'cancelled');
  assert.equal(runtimeConnectCalls, 1);
  assert.equal(runtime.getStatus().state, 'ready');
});
