import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import { GatewayClientError, GatewayClientStatus } from '@agent-plugin/gateway-client';
import {
  BridgeRuntimeError,
  createBridgeRuntime,
} from '../src/index.ts';
import type {
  BridgeGatewayHostConfig,
  BridgeGatewayLogger,
  BridgeRuntimeOptions,
  ProviderFact,
  ProviderRun,
  ProviderRuntimeContext,
  ProviderTerminalResult,
  ThirdPartyAgentProvider,
} from '../src/index.ts';
import type {
  BridgeGatewayHostConnection,
} from '../src/infrastructure/gateway/gateway-host.ts';
import { BridgeGatewayLoggerObservationAdapter } from '../src/adapters/observation/runtime-logger-observation.ts';
import { GatewayProbeDriver } from '../src/adapters/gateway/GatewayProbeDriver.ts';
import { GatewayRuntimeDriver } from '../src/adapters/gateway/GatewayRuntimeDriver.ts';
import { DefaultRuntimeObservation } from '../src/application/runtime-observation/index.ts';
import type { RuntimeObservationEvent } from '../src/application/runtime-observation/index.ts';
import {
  fromGatewayClosedFailure,
  fromGatewayConnectFailure,
  fromProbeFailure,
  fromProviderStartFailure,
  fromRuntimeInternalFailure,
} from '../src/application/runtime-error-classifier.ts';

function assertBridgeRuntimeError(
  error: unknown,
  expected: { code: BridgeRuntimeError['code']; message: string },
): void {
  assert.equal(error instanceof Error, true);
  assert.equal((error as Error).name, 'BridgeRuntimeError');
  assert.equal((error as BridgeRuntimeError).code, expected.code);
  assert.equal((error as Error).message, expected.message);
}

test('runtime error classifier owns lifecycle gateway and fallback mappings', () => {
  assertBridgeRuntimeError(fromGatewayConnectFailure(new GatewayClientError({
    code: 'GATEWAY_HANDSHAKE_REJECTED',
    disposition: 'startup_failure',
    retryable: false,
    message: 'rejected',
  })), {
    code: 'gateway_handshake_rejected',
    message: 'rejected',
  });
  assertBridgeRuntimeError(fromGatewayConnectFailure(new GatewayClientError({
    code: 'GATEWAY_NOT_READY',
    disposition: 'runtime_failure',
    retryable: false,
    message: 'not ready',
  })), {
    code: 'gateway_unknown_error',
    message: 'not ready',
  });
  assertBridgeRuntimeError(fromGatewayConnectFailure({
    code: 'GATEWAY_HANDSHAKE_REJECTED',
    message: 'plain object is not gateway client error',
  }), {
    code: 'gateway_unknown_error',
    message: 'plain object is not gateway client error',
  });
  assertBridgeRuntimeError(fromProviderStartFailure(new Error('provider failed')), {
    code: 'provider_unavailable',
    message: 'provider failed',
  });
  assertBridgeRuntimeError(fromRuntimeInternalFailure(new Error('cleanup failed')), {
    code: 'runtime_internal_error',
    message: 'cleanup failed',
  });
  assertBridgeRuntimeError(fromRuntimeInternalFailure(new GatewayClientError({
    code: 'GATEWAY_TRANSPORT_ERROR',
    disposition: 'runtime_failure',
    retryable: false,
    message: 'cleanup gateway failure',
  })), {
    code: 'runtime_internal_error',
    message: 'cleanup gateway failure',
  });
  assertBridgeRuntimeError(fromProbeFailure(new Error('probe failed')), {
    code: 'probe_unknown_error',
    message: 'probe failed',
  });
  assert.equal(fromGatewayClosedFailure(new GatewayClientError({
    code: 'GATEWAY_CLOSED_MANUAL',
    disposition: 'cancelled',
    retryable: false,
    message: 'manual',
  })), null);
  assert.equal(fromGatewayClosedFailure(new GatewayClientError({
    code: 'GATEWAY_CONNECT_ABORTED',
    disposition: 'cancelled',
    retryable: false,
    message: 'aborted',
  })), null);

  const existing = new BridgeRuntimeError('runtime_internal_error', 'already classified');
  assert.equal(fromRuntimeInternalFailure(existing), existing);
});

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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createTestObservation() {
  const events: RuntimeObservationEvent[] = [];
  return {
    events,
    observation: new DefaultRuntimeObservation({
      record(event) {
        events.push(event);
      },
    }),
  };
}

function createHangingFacts(
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

class FakeGatewayClient extends EventEmitter implements BridgeGatewayHostConnection {
  sent: unknown[] = [];
  state: 'DISCONNECTED' | 'CONNECTING' | 'READY' = 'DISCONNECTED';
  connectError: Error | null = null;
  reconnecting = false;
  closedCode: 'GATEWAY_CLOSED_MANUAL' | 'GATEWAY_CONNECT_ABORTED' | 'GATEWAY_AUTH_REJECTED' | 'GATEWAY_TRANSPORT_ERROR' | 'GATEWAY_RECONNECT_EXHAUSTED' | null = null;

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

function createRuntimeOptions(
  provider: ThirdPartyAgentProvider,
  connection: FakeGatewayClient,
  extra?: Partial<BridgeRuntimeOptions> & {
    toolDoneCompatDelay?: {
      sleep?: (ms: number) => Promise<void>;
      delayMs?: number;
    };
  },
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
    toolDoneCompatDelay: {
      sleep: async () => {},
    },
    ...extra,
  };
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

test('default runtime observation maps gateway probe events', () => {
  const { events, observation } = createTestObservation();

  observation.gatewayProbeRequested('ws://gateway.local', 50);
  observation.gatewayProbeCompleted('ws://gateway.local', 'connect_error', 12, 'gateway_not_connected');

  assert.deepEqual(events, [
    {
      type: 'gateway_probe',
      phase: 'requested',
      gatewayUrl: 'ws://gateway.local',
      timeoutMs: 50,
    },
    {
      type: 'gateway_probe',
      phase: 'completed',
      gatewayUrl: 'ws://gateway.local',
      state: 'connect_error',
      latencyMs: 12,
      reason: 'gateway_not_connected',
    },
  ]);
});

test('logger observation adapter projects gateway probe events', () => {
  const records: Array<{ level: string; message: string; meta: Record<string, unknown> }> = [];
  const adapter = new BridgeGatewayLoggerObservationAdapter({
    info(message, meta) {
      records.push({ level: 'info', message, meta: meta ?? {} });
    },
    warn(message, meta) {
      records.push({ level: 'warn', message, meta: meta ?? {} });
    },
    error(message, meta) {
      records.push({ level: 'error', message, meta: meta ?? {} });
    },
  });

  adapter.record({
    type: 'gateway_probe',
    phase: 'requested',
    gatewayUrl: 'ws://gateway.local',
    timeoutMs: 50,
  });
  adapter.record({
    type: 'gateway_probe',
    phase: 'completed',
    gatewayUrl: 'ws://gateway.local',
    state: 'connect_error',
    latencyMs: 12,
    reason: 'gateway_not_connected',
  });

  assert.deepEqual(records, [
    {
      level: 'info',
      message: 'runtime_sdk.gateway_probe.requested',
      meta: {
        gatewayUrl: 'ws://gateway.local',
        timeoutMs: 50,
      },
    },
    {
      level: 'error',
      message: 'runtime_sdk.gateway_probe.completed',
      meta: {
        gatewayUrl: 'ws://gateway.local',
        state: 'connect_error',
        latencyMs: 12,
        reason: 'gateway_not_connected',
      },
    },
  ]);
});

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

test('runtime lifecycle public api exposes stable start stop getStatus contract', async () => {
  const connection = new FakeGatewayClient();
  const initializeGate = createDeferred<void>();
  const disposeGate = createDeferred<void>();
  let factoryCalls = 0;
  let connectCalls = 0;
  let disconnectCalls = 0;
  let disposeCalls = 0;
  const provider = createProvider();
  provider.initialize = async () => {
    await initializeGate.promise;
  };
  provider.dispose = async () => {
    disposeCalls += 1;
    await disposeGate.promise;
  };
  connection.connect = async function connect(): Promise<void> {
    connectCalls += 1;
    this.state = 'CONNECTING';
    this.emitStatus();
    await flushEvents();
    this.state = 'READY';
    this.emitStatus();
  };
  connection.disconnect = async function disconnect(): Promise<void> {
    disconnectCalls += 1;
    this.reconnecting = false;
    this.closedCode = 'GATEWAY_CLOSED_MANUAL';
    this.state = 'DISCONNECTED';
    this.emitStatus();
  };
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(provider, connection, {
      connectionFactory: () => {
        factoryCalls += 1;
        return connection;
      },
    }),
  );

  assert.deepEqual(runtime.getStatus(), {
    state: 'idle',
    failureReason: null,
  });
  assert.equal(factoryCalls, 0);

  const startPromise = runtime.start();
  await flushEvents();
  const startingStatus = runtime.getStatus();
  assert.equal(startingStatus.state, 'starting');
  assert.equal(startingStatus.failureReason, null);
  assert.equal(startingStatus.error, undefined);
  assert.equal(factoryCalls, 0);
  assert.equal(connectCalls, 0);

  initializeGate.resolve();
  await startPromise;
  assert.deepEqual(runtime.getStatus(), {
    state: 'ready',
    failureReason: null,
  });
  assert.equal(factoryCalls, 1);
  assert.equal(connectCalls, 1);

  await runtime.start();
  assert.equal(factoryCalls, 1);
  assert.equal(connectCalls, 1);

  const stopPromise = runtime.stop();
  await flushEvents();
  const stoppingStatus = runtime.getStatus();
  assert.equal(stoppingStatus.state, 'stopping');
  assert.equal(stoppingStatus.failureReason, null);
  assert.equal(stoppingStatus.error, undefined);
  assert.equal(disconnectCalls, 1);
  assert.equal(disposeCalls, 1);

  disposeGate.resolve();
  await stopPromise;
  assert.deepEqual(runtime.getStatus(), {
    state: 'idle',
    failureReason: null,
  });

  await runtime.stop();
  assert.equal(disconnectCalls, 1);
  assert.equal(disposeCalls, 1);
});

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
          { type: 'message.start', messageId: 'msg-1' },
          { type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: 'he' },
          { type: 'text.done', messageId: 'msg-1', partId: 'part-1', content: 'hello' },
          { type: 'message.done', messageId: 'msg-1' },
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

test('runtime preserves stream fact content verbatim when projecting uplinks', async () => {
  const connection = new FakeGatewayClient();
  const originalContent = '  keep leading spaces\nand trailing tabs\t';
  const toolContent = {
    title: '  Run command\t',
    input: '   ',
    output: '',
    error: '\nfailed\t',
  };
  const provider: ThirdPartyAgentProvider = {
    ...createProvider(),
    async runMessage() {
      return createFakeRun(
        [
          { type: 'message.start', messageId: 'msg-1' },
          { type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: originalContent },
          {
            type: 'tool.update',
            messageId: 'msg-1',
            partId: 'part-tool-1',
            toolCallId: 'tool-call-1',
            toolName: 'bash',
            status: 'error',
            ...toolContent,
          },
          { type: 'message.done', messageId: 'msg-1' },
        ],
        { outcome: 'completed' },
      );
    },
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent[1], {
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      protocol: 'cloud',
      type: 'text.delta',
      properties: { messageId: 'msg-1', partId: 'part-1', content: originalContent },
    },
  });
  assert.deepEqual(connection.sent[2], {
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      protocol: 'cloud',
      type: 'tool.update',
      properties: {
        messageId: 'msg-1',
        partId: 'part-tool-1',
        toolCallId: 'tool-call-1',
        toolName: 'bash',
        status: 'error',
        ...toolContent,
      },
    },
  });
});

test('runtime responds to status_query with provider health status', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.emitMessage({
    type: 'status_query',
    welinkSessionId: 'welink-status-1',
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'status_response',
    opencodeOnline: true,
  });
});

test('runtime projects subagent envelope fields from provider facts onto tool_event messages', async () => {
  const connection = new FakeGatewayClient();
  const provider: ThirdPartyAgentProvider = {
    async health() {
      return { online: true };
    },
    async createSession() {
      return { toolSessionId: 'tool-parent-1' };
    },
    async runMessage() {
      return createFakeRun(
        [
          {
            type: 'message.start',
            subagentSessionId: 'ses-child-1',
            subagentName: 'research-agent',
            messageId: 'msg-subagent-1',
          },
          {
            type: 'text.done',
            subagentSessionId: 'ses-child-1',
            subagentName: 'research-agent',
            messageId: 'msg-subagent-1',
            partId: 'part-subagent-1',
            content: 'hello from child',
          },
          {
            type: 'message.done',
            subagentSessionId: 'ses-child-1',
            subagentName: 'research-agent',
            messageId: 'msg-subagent-1',
          },
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

  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-subagent-1',
    payload: { toolSessionId: 'tool-parent-1', text: 'hi' },
  });
  await flushEvents();

  const toolEvents = connection.sent.filter(
    (message): message is Record<string, unknown> =>
      typeof message === 'object' && message !== null && 'type' in message && message.type === 'tool_event',
  );
  assert.equal(toolEvents.length >= 2, true);
  assert.equal(toolEvents.every((message) => message.subagentSessionId === 'ses-child-1'), true);
  assert.equal(toolEvents.every((message) => message.subagentName === 'research-agent'), true);
});

test('abort_session forwards active run id and sends tool_done when run resolves aborted', async () => {
  const connection = new FakeGatewayClient();
  let finishFacts: (() => void) | undefined;
  let resolveTerminal: ((result: ProviderTerminalResult) => void) | undefined;
  let capturedAbortInput: Record<string, unknown> | undefined;
  let capturedRunId: string | undefined;
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage(input) {
          capturedRunId = input.runId;
          const facts = {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                finishFacts = resolve;
              });
            },
          };
          return {
            runId: input.runId,
            facts,
            result() {
              return new Promise<ProviderTerminalResult>((resolve) => {
                resolveTerminal = resolve;
              });
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
        async abortSession(input) {
          capturedAbortInput = input as unknown as Record<string, unknown>;
          finishFacts?.();
          resolveTerminal?.({ outcome: 'aborted' });
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
  connection.emitMessage({
    type: 'invoke',
    action: 'abort_session',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1' },
  });
  await flushEvents();

  assert.ok(capturedRunId);
  assert.deepEqual(capturedAbortInput, {
    traceId: 'trace-fixed',
    toolSessionId: 'tool-1',
    runId: capturedRunId,
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_done',
    toolSessionId: 'tool-1',
  });
});

test('abort_session without active request run passes undefined runId and keeps toolSessionId reusable', async () => {
  const connection = new FakeGatewayClient();
  let capturedAbortInput: Record<string, unknown> | undefined;
  let runCount = 0;
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        ...createProvider(),
        async runMessage() {
          runCount += 1;
          return createFakeRun(
            [
              { type: 'message.start', messageId: `msg-${runCount}` },
              { type: 'message.done', messageId: `msg-${runCount}` },
            ],
            { outcome: 'completed' },
          );
        },
        async abortSession(input) {
          capturedAbortInput = input as unknown as Record<string, unknown>;
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
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'abort_session',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'second' },
  });
  await flushEvents();

  assert.ok(capturedAbortInput);
  assert.equal(capturedAbortInput.runId, undefined);
  assert.equal(runCount, 2);
  assert.equal(
    connection.sent.filter((message) =>
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'tool_done'
      && 'toolSessionId' in message
      && message.toolSessionId === 'tool-1'
    ).length,
    2,
  );
});

test('abort_session keeps active request run occupied until aborted run settles', async () => {
  const connection = new FakeGatewayClient();
  const firstRunResult = createDeferred<ProviderTerminalResult>();
  let capturedAbortInput: Record<string, unknown> | undefined;
  let runCount = 0;
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        ...createProvider(),
        async runMessage(input) {
          runCount += 1;
          if (runCount === 1) {
            return {
              runId: input.runId,
              facts: createAsyncFacts([]),
              result: async () => firstRunResult.promise,
            };
          }
          return createFakeRun(
            [
              { type: 'message.start', messageId: `msg-${runCount}` },
              { type: 'message.done', messageId: `msg-${runCount}` },
            ],
            { outcome: 'completed' },
          );
        },
        async abortSession(input) {
          capturedAbortInput = input as unknown as Record<string, unknown>;
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
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'abort_session',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-2',
    payload: { toolSessionId: 'tool-1', text: 'second' },
  });
  await flushEvents();

  assert.equal(runCount, 1);
  assert.ok(capturedAbortInput?.runId);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: '当前会话正在处理中，请稍后再试',
  });

  firstRunResult.resolve({ outcome: 'aborted' });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-3',
    payload: { toolSessionId: 'tool-1', text: 'third' },
  });
  await flushEvents();

  assert.equal(runCount, 2);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_done',
    toolSessionId: 'tool-1',
  });
});

test('start_request_run reuses session welinkSessionId when chat invoke omits it', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'create_session',
    welinkSessionId: 'welink-1',
    payload: { title: 'demo' },
  });
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
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
  });
});

test('start_request_run passes typed invoke.chat context to provider runMessage', async () => {
  const connection = new FakeGatewayClient();
  let capturedInput: Record<string, unknown> | undefined;
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage(input) {
          capturedInput = input as unknown as Record<string, unknown>;
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
    action: 'chat',
    welinkSessionId: 'welink-1',
    suppressReply: true,
    payload: {
      toolSessionId: 'tool-1',
      text: 'hi',
      assistantId: 'assistant-1',
      assistantAccount: 'assistant-account',
      sendUserAccount: 'user-account',
      imGroupId: 'group-1',
      extParameters: {
        businessExtParam: {
          scene: 'workflow',
          nested: {
            enabled: true,
          },
        },
        platformExtParam: {
          businessSessionDomain: 'im',
          businessSessionType: 'group',
          businessSessionId: 'session-1',
          allowedSlashCommands: ['plan', 'run'],
        },
      },
    },
  });
  await flushEvents();

  assert.equal(typeof capturedInput?.runId, 'string');
  assert.deepEqual(capturedInput, {
    traceId: 'trace-fixed',
    runId: capturedInput?.runId,
    toolSessionId: 'tool-1',
    text: 'hi',
    assistantId: 'assistant-1',
    extParameters: {
      businessExtParam: {
        scene: 'workflow',
        nested: {
          enabled: true,
        },
      },
      platformExtParam: {
        businessSessionDomain: 'im',
        businessSessionType: 'group',
        businessSessionId: 'session-1',
        allowedSlashCommands: ['plan', 'run'],
      },
    },
    context: {
      assistantAccount: 'assistant-account',
      sendUserAccount: 'user-account',
      imGroupId: 'group-1',
      suppressReply: true,
    },
  });
});

test('start_request_run omits absent extParameters in provider runMessage input', async () => {
  const connection = new FakeGatewayClient();
  let capturedInput: Record<string, unknown> | undefined;
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage(input) {
          capturedInput = input as unknown as Record<string, unknown>;
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
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: {
      toolSessionId: 'tool-1',
      text: 'hi',
    },
  });
  await flushEvents();

  assert.ok(capturedInput);
  assert.equal('extParameters' in capturedInput, false);
});

test('runtime consumes question replies by questionId and forwards structured answers', async () => {
  const connection = new FakeGatewayClient();
  let capturedQuestionReply: Record<string, unknown> | undefined;
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
              { type: 'message.start', messageId: 'msg-1' },
              {
                type: 'question.ask',
                messageId: 'msg-1',
                partId: 'part-question-1',
                questionId: 'question-1',
                status: 'running',
                extParam: { scene: 'confirm' },
                questions: [
                  {
                    question: 'Pick one',
                    header: 'Header',
                    options: [{ label: 'A', description: 'First option' }, { label: 'B' }],
                  },
                ],
              },
              { type: 'message.done', messageId: 'msg-1' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion(input) {
          capturedQuestionReply = input as unknown as Record<string, unknown>;
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
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    payload: { questionId: 'question-1', answer: 'A' },
  });
  await flushEvents();

  assert.deepEqual(capturedQuestionReply, {
    traceId: 'trace-fixed',
    questionId: 'question-1',
    answers: [['A']],
  });
});

test('runtime consumes permission replies by permissionId and forwards reply contract', async () => {
  const connection = new FakeGatewayClient();
  let capturedPermissionReply: Record<string, unknown> | undefined;
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
              { type: 'message.start', messageId: 'msg-1' },
              {
                type: 'permission.ask',
                messageId: 'msg-1',
                partId: 'part-permission-1',
                permissionId: 'permission-1',
                permType: 'file_write',
              },
              { type: 'message.done', messageId: 'msg-1' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission(input) {
          capturedPermissionReply = input as unknown as Record<string, unknown>;
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
  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-1', response: 'always' },
  });
  await flushEvents();

  assert.deepEqual(capturedPermissionReply, {
    traceId: 'trace-fixed',
    permissionId: 'permission-1',
    reply: 'always',
  });
});

test('close_session preserves pending question reply token routing', async () => {
  const connection = new FakeGatewayClient();
  const repliedQuestionIds: string[] = [];
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
              { type: 'message.start', messageId: 'msg-1' },
              {
                type: 'question.ask',
                messageId: 'msg-1',
                partId: 'part-question-1',
                questionId: 'question-close-1',
                questions: [{ question: 'Proceed?' }],
              },
              { type: 'message.done', messageId: 'msg-1' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion(input) {
          repliedQuestionIds.push(input.questionId);
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
  connection.emitMessage({
    type: 'invoke',
    action: 'close_session',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    payload: { questionId: 'question-close-1', answer: 'yes' },
  });
  await flushEvents();

  assert.deepEqual(repliedQuestionIds, ['question-close-1']);
});

test('close_session preserves pending permission reply token routing', async () => {
  const connection = new FakeGatewayClient();
  const repliedPermissionIds: string[] = [];
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
              { type: 'message.start', messageId: 'msg-1' },
              {
                type: 'permission.ask',
                messageId: 'msg-1',
                partId: 'part-permission-1',
                permissionId: 'permission-close-1',
                permType: 'file_write',
              },
              { type: 'message.done', messageId: 'msg-1' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission(input) {
          repliedPermissionIds.push(input.permissionId);
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
  connection.emitMessage({
    type: 'invoke',
    action: 'close_session',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-close-1', response: 'always' },
  });
  await flushEvents();

  assert.deepEqual(repliedPermissionIds, ['permission-close-1']);
});

test('question.ask projects cloud questions payload and omits legacy flat fields', async () => {
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
              { type: 'message.start', messageId: 'msg-1' },
              {
                type: 'question.ask',
                messageId: 'msg-1',
                partId: 'part-question-1',
                questionId: 'question-1',
                toolCallId: 'call-question-1',
                status: 'running',
                extParam: { scene: 'confirm' },
                questions: [
                  {
                    question: 'Pick one',
                    header: 'Header',
                    options: [{ label: 'A', description: 'First option' }, { label: 'B' }],
                    multiSelect: true,
                  },
                ],
              },
              { type: 'message.done', messageId: 'msg-1' },
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

  const questionEvent = connection.sent.find((message) =>
    typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'tool_event'
    && 'event' in message
    && typeof message.event === 'object'
    && message.event !== null
    && 'type' in message.event
    && message.event.type === 'question',
  );
  assert.deepEqual(questionEvent, {
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      protocol: 'cloud',
      type: 'question',
      properties: {
        messageId: 'msg-1',
        partId: 'part-question-1',
        questionId: 'question-1',
        toolCallId: 'call-question-1',
        status: 'running',
        extParam: { scene: 'confirm' },
        questions: [
          {
            question: 'Pick one',
            header: 'Header',
            options: [{ label: 'A', description: 'First option' }, { label: 'B' }],
            multiSelect: true,
          },
        ],
      },
    },
  });
});

test('permission.reply and session.title facts project to gateway tool_event uplinks', async () => {
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
                type: 'permission.ask',
                permissionId: 'permission-1',
                partId: 'part-1',
                messageId: 'msg-1',
                permType: 'file_write',
              },
              {
                type: 'permission.reply',
                permissionId: 'permission-1',
                response: 'once',
                permType: 'file_write',
              },
              {
                type: 'session.title',
                title: 'Updated Title',
              },
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

  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'permission.reply',
        properties: {
          permissionId: 'permission-1',
          response: 'once',
          permType: 'file_write',
          messageId: 'msg-1',
          partId: 'part-1',
        },
      },
    })),
    true,
  );
  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'session.title',
        properties: {
          title: 'Updated Title',
        },
      },
    })),
    true,
  );
});

test('permission.reply without ask presentation context does not emit permission reply tool_event', async () => {
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
                type: 'permission.reply',
                permissionId: 'permission-missing-1',
                response: 'once',
                permType: 'file_write',
              },
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

  assert.equal(
    connection.sent.some((message) =>
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'tool_event'
      && 'event' in message
      && typeof message.event === 'object'
      && message.event !== null
      && 'type' in message.event
      && message.event.type === 'permission.reply'),
    false,
  );
});

test('question.ask duplicate registration in the same session is idempotent', async () => {
  const connection = new FakeGatewayClient();
  let replyCount = 0;
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
              { type: 'message.start', messageId: 'msg-1' },
              {
                type: 'question.ask',
                messageId: 'msg-1',
                partId: 'part-question-1',
                questionId: 'question-1',
                questions: [{ question: 'Pick one' }],
              },
              {
                type: 'question.ask',
                messageId: 'msg-1',
                partId: 'part-question-1',
                questionId: 'question-1',
                questions: [{ question: 'Pick one' }],
              },
              { type: 'message.done', messageId: 'msg-1' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          replyCount += 1;
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
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    payload: { questionId: 'question-1', answer: 'A' },
  });
  await flushEvents();

  assert.equal(replyCount, 1);
  assert.equal(runtime.getStatus().state, 'ready');
  assert.notDeepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'question interaction reply target must be globally unique',
    code: 'pending_interaction_conflict',
  });
});

test('question.ask backfills toolCallId from questionId when fact omits legacy field', async () => {
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
              { type: 'message.start', messageId: 'msg-1' },
              {
                type: 'question.ask',
                messageId: 'msg-1',
                partId: 'part-question-2',
                questionId: 'question-2',
                questions: [{ question: 'Proceed?' }],
              },
              { type: 'message.done', messageId: 'msg-1' },
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

  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'question',
        properties: {
          messageId: 'msg-1',
          partId: 'part-question-2',
          questionId: 'question-2',
          toolCallId: 'question-2',
          questions: [{ question: 'Proceed?' }],
        },
      },
    })),
    true,
  );
});

test('permission.ask projects independent partId and permissionId only', async () => {
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
              { type: 'message.start', messageId: 'msg-1' },
              {
                type: 'permission.ask',
                messageId: 'msg-1',
                partId: 'part-permission-1',
                permissionId: 'permission-1',
                permType: 'file_write',
                title: 'Allow file write',
              },
              { type: 'message.done', messageId: 'msg-1' },
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

  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'permission.ask',
        properties: {
          messageId: 'msg-1',
          partId: 'part-permission-1',
          permissionId: 'permission-1',
          permType: 'file_write',
          title: 'Allow file write',
        },
      },
    })),
    true,
  );
});

test('permission.ask remains valid without messageId and still registers reply target', async () => {
  const connection = new FakeGatewayClient();
  let replyCount = 0;
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
                type: 'permission.ask',
                partId: 'permission-1',
                permissionId: 'permission-1',
                permType: 'file_write',
                title: 'Allow file write',
              },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission() {
          replyCount += 1;
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

  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'permission.ask',
        properties: {
          partId: 'permission-1',
          permissionId: 'permission-1',
          permType: 'file_write',
          title: 'Allow file write',
        },
      },
    })),
    true,
  );

  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-1', response: 'once' },
  });
  await flushEvents();

  assert.equal(replyCount, 1);
  assert.equal(runtime.getStatus().state, 'ready');
});

test('question.ask rejects globally duplicated questionId across sessions without clearing pending interactions', async () => {
  const connection = new FakeGatewayClient();
  const repliedQuestionIds: string[] = [];
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage(input) {
          if (input.toolSessionId === 'tool-1') {
            return createFakeRun(
              [
                { type: 'message.start', messageId: 'msg-1' },
                {
                  type: 'question.ask',
                  messageId: 'msg-1',
                  partId: 'part-question-1',
                  questionId: 'question-dup',
                  questions: [{ question: 'First question' }],
                },
                { type: 'message.done', messageId: 'msg-1' },
              ],
              { outcome: 'completed' },
            );
          }
          return createFakeRun(
            [
              { type: 'message.start', messageId: 'msg-2' },
              {
                type: 'question.ask',
                messageId: 'msg-2',
                partId: 'part-question-current',
                questionId: 'question-current',
                questions: [{ question: 'Current question' }],
              },
              {
                type: 'question.ask',
                messageId: 'msg-2',
                partId: 'part-question-2',
                questionId: 'question-dup',
                questions: [{ question: 'Second question' }],
              },
              { type: 'message.done', messageId: 'msg-2' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion(input) {
          repliedQuestionIds.push(input.questionId);
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
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-2',
    payload: { toolSessionId: 'tool-2', text: 'second' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    payload: { questionId: 'question-dup', answer: 'A' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    payload: { questionId: 'question-current', answer: 'B' },
  });
  await flushEvents();

  assert.deepEqual(repliedQuestionIds, ['question-dup', 'question-current']);
  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(connection.sent.findLast((message) => {
    return typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'tool_error'
      && 'toolSessionId' in message
      && message.toolSessionId === 'tool-2';
  }), {
    type: 'tool_error',
    toolSessionId: 'tool-2',
    error: '当前请求处理失败，请重试',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'question interaction reply target must be globally unique',
    code: 'pending_interaction_conflict',
  });
});

test('permission.ask rejects globally duplicated permissionId across sessions without clearing pending interactions', async () => {
  const connection = new FakeGatewayClient();
  const repliedPermissionIds: string[] = [];
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage(input) {
          if (input.toolSessionId === 'tool-1') {
            return createFakeRun(
              [
                { type: 'message.start', messageId: 'msg-1' },
                {
                  type: 'permission.ask',
                  messageId: 'msg-1',
                  partId: 'part-permission-1',
                  permissionId: 'permission-dup',
                  permType: 'file_write',
                },
                { type: 'message.done', messageId: 'msg-1' },
              ],
              { outcome: 'completed' },
            );
          }
          return createFakeRun(
            [
              { type: 'message.start', messageId: 'msg-2' },
              {
                type: 'permission.ask',
                messageId: 'msg-2',
                partId: 'part-permission-current',
                permissionId: 'permission-current',
                permType: 'file_write',
              },
              {
                type: 'permission.ask',
                messageId: 'msg-2',
                partId: 'part-permission-2',
                permissionId: 'permission-dup',
                permType: 'file_write',
              },
              { type: 'message.done', messageId: 'msg-2' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission(input) {
          repliedPermissionIds.push(input.permissionId);
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
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-2',
    payload: { toolSessionId: 'tool-2', text: 'second' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-dup', response: 'once' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-current', response: 'always' },
  });
  await flushEvents();

  assert.deepEqual(repliedPermissionIds, ['permission-dup', 'permission-current']);
  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(connection.sent.findLast((message) => {
    return typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'tool_error'
      && 'toolSessionId' in message
      && message.toolSessionId === 'tool-2';
  }), {
    type: 'tool_error',
    toolSessionId: 'tool-2',
    error: '当前请求处理失败，请重试',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'permission interaction reply target must be globally unique',
    code: 'pending_interaction_conflict',
  });
});

test('runtime start trusts gateway-client connect READY contract', async () => {
  const connection = new FakeGatewayClient();
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
    await flushEvents();
    this.state = 'READY';
    this.emitStatus();
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
    this.emitStatus();
    throw new Error('connect_failed_after_open');
  };
  connection.disconnect = function disconnect(): void {
    disconnectCalls += 1;
    this.state = 'DISCONNECTED';
    this.emitStatus();
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await assert.rejects(runtime.start(), /connect_failed_after_open/);

  assert.equal(disconnectCalls, 1);
  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'connect_failed_after_open',
    error: new BridgeRuntimeError('gateway_unknown_error', 'connect_failed_after_open'),
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
    error: new BridgeRuntimeError('provider_unavailable', 'provider_init_failed'),
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'startup_failure',
    phase: 'start',
    message: 'provider_init_failed',
    code: 'provider_unavailable',
  });
});

test('failed runtime status returns immutable cloned BridgeRuntimeError snapshots', async () => {
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
  const first = runtime.getStatus();
  const second = runtime.getStatus();

  assert.ok(first.error instanceof BridgeRuntimeError);
  assert.ok(Object.isFrozen(first.error));
  assert.notEqual(first.error, second.error);
  assert.equal(second.error?.code, 'provider_unavailable');
  assert.equal(second.error?.message, 'provider_init_failed');
});

test('runtime start wraps provider initialize failure as BridgeRuntimeError', async () => {
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

  await assert.rejects(
    runtime.start(),
    (error) => {
      assertBridgeRuntimeError(error, {
        code: 'provider_unavailable',
        message: 'provider_init_failed',
      });
      return true;
    },
  );
});

test('runtime start maps typed gateway-client connect failure into status error', async () => {
  const connection = new FakeGatewayClient();
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
    throw new GatewayClientError({
      code: 'GATEWAY_HANDSHAKE_TIMEOUT',
      disposition: 'startup_failure',
      retryable: true,
      message: 'handshake timed out',
    });
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await assert.rejects(
    runtime.start(),
    (error) => {
      assertBridgeRuntimeError(error, {
        code: 'gateway_handshake_timeout',
        message: 'handshake timed out',
      });
      return true;
    },
  );

  const firstStatus = runtime.getStatus();
  const secondStatus = runtime.getStatus();
  assert.equal(firstStatus.state, 'failed');
  assert.equal(firstStatus.failureReason, 'handshake timed out');
  assert.equal(firstStatus.error?.code, 'gateway_handshake_timeout');
  assert.equal(firstStatus.error?.message, 'handshake timed out');
  assert.ok(firstStatus.error instanceof BridgeRuntimeError);
  assert.ok(Object.isFrozen(firstStatus.error));
  assert.notEqual(firstStatus.error, secondStatus.error);
  assert.equal(secondStatus.error?.code, 'gateway_handshake_timeout');
});

test('runtime start preserves original message when disconnect cleanup throws', async () => {
  const connection = new FakeGatewayClient();
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTED';
    this.emitStatus();
    throw new Error('connect_failed_after_open');
  };
  connection.disconnect = function disconnect(): void {
    throw new Error('disconnect_cleanup_failed');
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await assert.rejects(
    runtime.start(),
    (error) => {
      assertBridgeRuntimeError(error, {
        code: 'gateway_unknown_error',
        message: 'connect_failed_after_open',
      });
      return true;
    },
  );

  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'connect_failed_after_open',
    error: new BridgeRuntimeError('gateway_unknown_error', 'connect_failed_after_open'),
  });
});

test('runtime stop wraps dispose failure as BridgeRuntimeError', async () => {
  const connection = new FakeGatewayClient();
  const provider = createProvider();
  provider.dispose = async () => {
    throw new Error('provider_dispose_failed');
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  await assert.rejects(
    runtime.stop(),
    (error) => {
      assertBridgeRuntimeError(error, {
        code: 'runtime_internal_error',
        message: 'provider_dispose_failed',
      });
      return true;
    },
  );
});

test('runtime stop still disposes provider when disconnect throws', async () => {
  const connection = new FakeGatewayClient();
  let disposeCalls = 0;
  const provider = createProvider();
  provider.dispose = async () => {
    disposeCalls += 1;
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  connection.disconnect = function disconnect(): void {
    throw new Error('disconnect_failed');
  };

  await assert.rejects(
    runtime.stop(),
    (error) => {
      assertBridgeRuntimeError(error, {
        code: 'runtime_internal_error',
        message: 'disconnect_failed',
      });
      return true;
    },
  );
  assert.equal(disposeCalls, 1);
});

test('runtime stop maps typed gateway-client disconnect failure as runtime internal error', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.disconnect = async function disconnect(): Promise<void> {
    throw new GatewayClientError({
      code: 'GATEWAY_TRANSPORT_ERROR',
      disposition: 'runtime_failure',
      retryable: false,
      message: 'disconnect transport failed',
    });
  };

  await assert.rejects(
    runtime.stop(),
    (error) => {
      assertBridgeRuntimeError(error, {
        code: 'runtime_internal_error',
        message: 'disconnect transport failed',
      });
      return true;
    },
  );
  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'disconnect transport failed',
    error: new BridgeRuntimeError('runtime_internal_error', 'disconnect transport failed'),
  });
});

test('runtime stop maps typed gateway-client provider cleanup failure as runtime internal error', async () => {
  const connection = new FakeGatewayClient();
  const provider = createProvider();
  provider.dispose = async () => {
    throw new GatewayClientError({
      code: 'GATEWAY_AUTH_REJECTED',
      disposition: 'runtime_failure',
      retryable: false,
      message: 'provider cleanup gateway failure',
    });
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  await assert.rejects(
    runtime.stop(),
    (error) => {
      assertBridgeRuntimeError(error, {
        code: 'runtime_internal_error',
        message: 'provider cleanup gateway failure',
      });
      return true;
    },
  );
  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'provider cleanup gateway failure',
    error: new BridgeRuntimeError('runtime_internal_error', 'provider cleanup gateway failure'),
  });
});

test('gateway runtime driver detaches observers when async disconnect rejects', async () => {
  const connection = new FakeGatewayClient();
  const options = createRuntimeOptions(createProvider(), connection);
  const { observation } = createTestObservation();
  const driver = new GatewayRuntimeDriver({
    gatewayHost: options.gatewayHost,
    observation,
    inboundPolicy: {
      handle() {},
    },
    connectionFactory: () => connection,
  });
  let statusChanges = 0;
  driver.attach({
    onGatewayStatusChanged() {
      statusChanges += 1;
    },
    onBusinessMessage() {},
  });

  await driver.connect();
  connection.disconnect = async function disconnect(): Promise<void> {
    throw new Error('disconnect_async_failed');
  };

  await assert.rejects(driver.disconnect(), /disconnect_async_failed/);
  connection.reconnecting = true;
  connection.emitStatus();

  assert.equal(statusChanges, 2);
  assert.equal(driver.isReady(), false);
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
  connection.reconnecting = true;
  connection.state = 'DISCONNECTED';
  connection.emitStatus();
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
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: 'run_failed',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'command_execution_failure',
    phase: 'runtime',
    message: 'run_failed',
    code: undefined,
  });
  assert.equal(runtime.getStatus().failureReason, null);
});

test('create_session command failure projects tool_error without echoing welinkSessionId', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          throw new Error('create_session_failed');
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
    action: 'create_session',
    welinkSessionId: 'welink-create-1',
    payload: { title: 'demo' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    error: 'create_session_failed',
  });
});

test('question_reply missing pending interaction projects tool_error', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    welinkSessionId: 'welink-question-missing-1',
    payload: { questionId: 'question-missing-1', answer: 'A' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    error: '当前交互已失效，请刷新后重试',
  });
});

test('permission_reply missing pending interaction projects tool_error', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    welinkSessionId: 'welink-permission-missing-1',
    payload: { permissionId: 'permission-missing-1', response: 'once' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    error: '当前交互已失效，请刷新后重试',
  });
});

test('run_already_active projects routable tool_error while preserving active request run lock', async () => {
  const connection = new FakeGatewayClient();
  const firstRunResult = createDeferred<ProviderTerminalResult>();
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
          return {
            runId: 'run-hanging-1',
            facts: createAsyncFacts([]),
            result: async () => firstRunResult.promise,
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
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-run-1',
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-run-2',
    payload: { toolSessionId: 'tool-1', text: 'second' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: '当前会话正在处理中，请稍后再试',
  });
  firstRunResult.resolve({ outcome: 'completed' });
  await flushEvents();
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
  assert.equal(runtime.getDiagnostics().gatewayState, 'ready');
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
      protocol: 'cloud',
      type: 'session.error',
      properties: {
        error: 'agent offline',
      },
    },
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: 'agent offline',
  });
});

test('request run delays terminal tool_done by 100ms', async () => {
  const connection = new FakeGatewayClient();
  const delay = createDeferred<void>();
  const delayCalls: number[] = [];
  const provider = createProvider();
  provider.runMessage = async () => createFakeRun([], { outcome: 'completed' });
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection, {
    toolDoneCompatDelay: {
      sleep(ms) {
        delayCalls.push(ms);
        return delay.promise;
      },
    },
  }));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.deepEqual(delayCalls, [100]);
  assert.equal(connection.sent.some((message) => (
    typeof message === 'object' && message !== null && 'type' in message && message.type === 'tool_done'
  )), false);
  assert.equal(runtime.getDiagnostics().uplinks.some((message) => message.type === 'tool_done'), false);

  delay.resolve();
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_done',
    toolSessionId: 'tool-1',
  });
  assert.equal(runtime.getDiagnostics().uplinks.at(-1)?.type, 'tool_done');
});

test('request run sends terminal tool_error without compatibility delay', async () => {
  const connection = new FakeGatewayClient();
  const delayCalls: number[] = [];
  const provider = createProvider();
  provider.runMessage = async () => createFakeRun([], {
    outcome: 'failed',
    error: {
      code: 'internal_error',
      message: 'provider failed',
    },
  });
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection, {
    toolDoneCompatDelay: {
      sleep(ms) {
        delayCalls.push(ms);
        return Promise.resolve();
      },
    },
  }));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.deepEqual(delayCalls, []);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: 'provider failed',
  });
});

test('request run skips terminal tool_done delay when compatibility delay is disabled', async () => {
  const connection = new FakeGatewayClient();
  const delayCalls: number[] = [];
  const provider = createProvider();
  provider.runMessage = async () => createFakeRun([], { outcome: 'completed' });
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection, {
    toolDoneCompatDelay: {
      sleep(ms) {
        delayCalls.push(ms);
        return Promise.resolve();
      },
      delayMs: 0,
    },
  }));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.deepEqual(delayCalls, []);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_done',
    toolSessionId: 'tool-1',
  });
});

test('terminal tool_error carries session_not_found reason when provider returns structured stale-session error', async () => {
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
          return createFakeRun([], {
            outcome: 'failed',
            error: {
              code: 'session_not_found',
              message: 'session missing',
            },
          });
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

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: 'session missing',
    reason: 'session_not_found',
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
            [{ type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: 'bad' }],
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
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: '当前请求处理失败，请重试',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'text.delta requires an open message',
    code: 'fact_sequence_invalid',
  });
  assert.equal(runtime.getStatus().failureReason, null);
});

test('emitOutboundRun projects multiple assistant messages in one outbound stream', async () => {
  const connection = new FakeGatewayClient();
  const provider = createProvider();
  let outbound: ProviderRuntimeContext['outbound'];
  provider.initialize = async (context) => {
    outbound = context.outbound;
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  await outbound.emitOutboundRun({
    toolSessionId: 'tool-outbound-run-1',
    runId: 'outbound-run-1',
    trigger: 'system',
    facts: createAsyncFacts([
      { type: 'message.start', messageId: 'msg-1' },
      { type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: 'hello' },
      { type: 'message.done', messageId: 'msg-1' },
      { type: 'message.start', messageId: 'msg-2' },
      { type: 'text.delta', messageId: 'msg-2', partId: 'part-2', content: 'again' },
      { type: 'message.done', messageId: 'msg-2' },
    ]),
  });
  await flushEvents();

  assert.deepEqual(connection.sent.slice(-7), [
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'step.start',
        properties: { messageId: 'msg-1' },
      },
    },
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'text.delta',
        properties: { messageId: 'msg-1', partId: 'part-1', content: 'hello' },
      },
    },
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'step.done',
        properties: { messageId: 'msg-1' },
      },
    },
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'step.start',
        properties: { messageId: 'msg-2' },
      },
    },
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'text.delta',
        properties: { messageId: 'msg-2', partId: 'part-2', content: 'again' },
      },
    },
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'step.done',
        properties: { messageId: 'msg-2' },
      },
    },
    {
      type: 'tool_done',
      toolSessionId: 'tool-outbound-run-1',
    },
  ]);
});

test('emitOutboundRun emits tool_error when facts fail validation', async () => {
  const connection = new FakeGatewayClient();
  const provider = createProvider();
  let outbound: ProviderRuntimeContext['outbound'];
  provider.initialize = async (context) => {
    outbound = context.outbound;
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  await assert.rejects(
    () => outbound.emitOutboundRun({
      toolSessionId: 'tool-outbound-run-invalid',
      runId: 'outbound-run-invalid',
      trigger: 'system',
      facts: createAsyncFacts([
        { type: 'text.delta', messageId: 'msg-invalid', partId: 'part-invalid', content: 'orphan' },
      ]),
    }),
    (error) => error instanceof Error && 'code' in error && error.code === 'fact_sequence_invalid',
  );
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-outbound-run-invalid',
    error: 'text.delta requires an open message',
  });
  assert.deepEqual(runtime.getDiagnostics().terminals.at(-1), {
    toolSessionId: 'tool-outbound-run-invalid',
    outcome: 'failed',
  });
});

test('outbound run and outbound message are mutually exclusive per tool session', async () => {
  const connection = new FakeGatewayClient();
  const provider = createProvider();
  let outbound: ProviderRuntimeContext['outbound'];
  provider.initialize = async (context) => {
    outbound = context.outbound;
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));
  const releaseRun = createDeferred<void>();

  await runtime.start();
  const activeRun = outbound.emitOutboundRun({
    toolSessionId: 'tool-outbound-lock-1',
    runId: 'outbound-run-lock-1',
    trigger: 'system',
    facts: createHangingFacts([
      { type: 'message.start', messageId: 'msg-lock-1' },
    ], releaseRun.promise),
  });
  await flushEvents();

  await assert.rejects(
    () => outbound.emitOutboundMessage({
      toolSessionId: 'tool-outbound-lock-1',
      messageId: 'msg-lock-conflict-1',
      trigger: 'system',
      facts: createAsyncFacts([{ type: 'session.error', error: { message: 'busy' } }]),
    }),
    (error) => error instanceof Error && 'code' in error && error.code === 'outbound_already_active',
  );

  releaseRun.resolve();
  await activeRun;

  const releaseMessage = createDeferred<void>();
  const activeMessage = outbound.emitOutboundMessage({
    toolSessionId: 'tool-outbound-lock-1',
    messageId: 'msg-lock-active-1',
    trigger: 'system',
    facts: createHangingFacts([
      { type: 'message.start', messageId: 'msg-lock-active-1' },
    ], releaseMessage.promise),
  });
  await flushEvents();

  await assert.rejects(
    () => outbound.emitOutboundRun({
      toolSessionId: 'tool-outbound-lock-1',
      runId: 'outbound-run-conflict-1',
      trigger: 'system',
      facts: createAsyncFacts([{ type: 'message.start', messageId: 'msg-lock-conflict-2' }]),
    }),
    (error) => error instanceof Error && 'code' in error && error.code === 'outbound_already_active',
  );

  releaseMessage.resolve();
  await activeMessage;
});

test('tool.update with non-string output fails closed before uplink projection', async () => {
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
              { type: 'message.start', messageId: 'msg-1' },
              {
                type: 'tool.update',
                messageId: 'msg-1',
                partId: 'part-tool-1',
                toolCallId: 'tool-call-1',
                toolName: 'bash',
                status: 'completed',
                output: { nested: true } as unknown as string,
              },
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
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: '当前请求处理失败，请重试',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'tool.update output must be a string',
    code: 'fact_sequence_invalid',
  });
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
    code: 'GATEWAY_HANDSHAKE_REJECTED',
    disposition: 'runtime_failure',
    retryable: false,
    message: 'rejected',
  });
  await flushEvents();

  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'rejected',
    error: new BridgeRuntimeError('gateway_handshake_rejected', 'rejected'),
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'gateway_runtime_failure',
    phase: 'runtime',
    message: 'rejected',
    code: 'GATEWAY_HANDSHAKE_REJECTED',
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
      channel: 'openx',
      toolVersion: '0.0.0',
      pluginVersion: '0.1.0',
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
    this.emitStatus();
    throw new Error('connect_failed_after_open');
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await assert.rejects(runtime.start(), /connect_failed_after_open/);
  connection.state = 'READY';
  connection.emitStatus();
  connection.state = 'DISCONNECTED';
  connection.emitStatus();

  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'connect_failed_after_open',
    error: new BridgeRuntimeError('gateway_unknown_error', 'connect_failed_after_open'),
  });
});

test('gateway runtime error preserves original gateway failure code in diagnostics', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.emitError({
    code: 'GATEWAY_FATAL',
    message: 'gateway_runtime_failed',
    retryable: false,
  });

  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'gateway_runtime_failed',
    error: new BridgeRuntimeError('gateway_unknown_error', 'gateway_runtime_failed'),
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'gateway_runtime_failure',
    phase: 'runtime',
    message: 'gateway_runtime_failed',
    code: 'GATEWAY_FATAL',
  });
});

test('gateway non-retryable closed status marks running runtime failed', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.closedCode = 'GATEWAY_TRANSPORT_ERROR';
  connection.state = 'DISCONNECTED';
  connection.emitStatus();

  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'GATEWAY_TRANSPORT_ERROR',
    error: new BridgeRuntimeError('gateway_transport_error', 'GATEWAY_TRANSPORT_ERROR'),
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'gateway_runtime_failure',
    phase: 'runtime',
    message: 'GATEWAY_TRANSPORT_ERROR',
    code: 'GATEWAY_TRANSPORT_ERROR',
  });
});

test('manual gateway close does not mark running runtime failed', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.closedCode = 'GATEWAY_CLOSED_MANUAL';
  connection.state = 'DISCONNECTED';
  connection.emitStatus();

  assert.deepEqual(runtime.getStatus(), {
    state: 'ready',
    failureReason: null,
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
  let connectionFactoryCalls = 0;
  const gatewayHost = {
    url: 'ws://gateway.local',
    auth: {
      ak: 'shared-ak',
      sk: 'shared-sk',
    },
    register: {
      channel: 'openx',
      toolVersion: '0.0.0',
      pluginVersion: '0.1.0',
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
    connectionFactory: () => {
      connectionFactoryCalls += 1;
      return runtimeConnection;
    },
  });

  await runtime.start();
  assert.equal(connectionFactoryCalls, 1);

  const result = await runtime.probe({ timeoutMs: 50 });

  assert.deepEqual(result.state, 'ready');
  assert.equal(connectionFactoryCalls, 1);
});

test('different runtimes with the same gateway url and ak own separate connections', async () => {
  const firstConnection = new FakeGatewayClient();
  const secondConnection = new FakeGatewayClient();
  let firstConnectCalls = 0;
  let secondConnectCalls = 0;
  firstConnection.connect = async function connect(): Promise<void> {
    firstConnectCalls += 1;
    this.state = 'CONNECTING';
    this.emitStatus();
    await flushEvents();
    this.state = 'READY';
    this.emitStatus();
  };
  secondConnection.connect = async function connect(): Promise<void> {
    secondConnectCalls += 1;
    this.state = 'CONNECTING';
    this.emitStatus();
    await flushEvents();
    this.state = 'READY';
    this.emitStatus();
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
          channel: 'openx',
          toolVersion: '0.0.0',
          pluginVersion: '0.1.0',
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
          channel: 'openx',
          toolVersion: '0.0.0',
          pluginVersion: '0.1.0',
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
    this.emitStatus();
    await flushEvents();
    this.state = 'READY';
    this.emitStatus();
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

test('start waits for in-flight stop before reconnecting', async () => {
  const connection = new FakeGatewayClient();
  let connectCalls = 0;
  let disposeStarted = false;
  const disposeGate = createDeferred<void>();
  const provider = createProvider();
  provider.dispose = async () => {
    disposeStarted = true;
    await disposeGate.promise;
  };
  connection.connect = async function connect(): Promise<void> {
    connectCalls += 1;
    this.state = 'READY';
    this.emitStatus();
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  const stopPromise = runtime.stop();
  while (!disposeStarted) {
    await flushEvents();
  }
  const restartPromise = runtime.start();
  await flushEvents();

  assert.equal(connectCalls, 1);
  disposeGate.resolve();
  await stopPromise;
  await restartPromise;

  assert.equal(connectCalls, 2);
  assert.equal(runtime.getStatus().state, 'ready');
});

test('stop during start settles to idle', async () => {
  const connection = new FakeGatewayClient();
  const connectGate = createDeferred<void>();
  let disconnectCalls = 0;
  const logs: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const logger: BridgeGatewayLogger = {
    info(message, meta) {
      logs.push({ message, meta: meta ?? {} });
    },
  };
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
    await connectGate.promise;
    this.state = 'READY';
    this.emitStatus();
  };
  connection.disconnect = async function disconnect(): Promise<void> {
    disconnectCalls += 1;
    this.state = 'DISCONNECTED';
    this.emitStatus();
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection, { logger }));

  const startPromise = runtime.start();
  await flushEvents();
  const stopPromise = runtime.stop();
  connectGate.resolve();
  await Promise.all([startPromise, stopPromise]);

  assert.deepEqual(runtime.getStatus(), {
    state: 'idle',
    failureReason: null,
  });
  assert.equal(logs.some((log) => log.message === 'runtime_sdk.start.completed'), false);
  assert.equal(logs.some((log) => log.message === 'runtime_sdk.stop.completed'), true);
  assert.equal(disconnectCalls, 1);
});

test('stop during start avoids duplicate disconnect when no connection becomes ready', async () => {
  const connection = new FakeGatewayClient();
  const connectGate = createDeferred<void>();
  let disconnectCalls = 0;
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
    await connectGate.promise;
  };
  connection.disconnect = async function disconnect(): Promise<void> {
    disconnectCalls += 1;
    this.state = 'DISCONNECTED';
    this.emitStatus();
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  const startPromise = runtime.start();
  await flushEvents();
  const stopPromise = runtime.stop();
  connectGate.resolve();
  await Promise.all([startPromise, stopPromise]);

  assert.deepEqual(runtime.getStatus(), {
    state: 'idle',
    failureReason: null,
  });
  assert.equal(disconnectCalls, 1);
});

test('stop during start ignores stale connect rejection', async () => {
  const connection = new FakeGatewayClient();
  const connectGate = createDeferred<void>();
  const logs: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const logger: BridgeGatewayLogger = {
    error(message, meta) {
      logs.push({ message, meta: meta ?? {} });
    },
    info(message, meta) {
      logs.push({ message, meta: meta ?? {} });
    },
  };
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
    await connectGate.promise;
    this.state = 'READY';
    this.emitStatus();
  };
  connection.disconnect = function disconnect(): void {
    connectGate.reject(new Error('connect_aborted_by_stop'));
    this.state = 'DISCONNECTED';
    this.emitStatus();
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection, { logger }));

  const startPromise = runtime.start();
  await flushEvents();
  const stopPromise = runtime.stop();
  await Promise.all([startPromise, stopPromise]);

  assert.deepEqual(runtime.getStatus(), {
    state: 'idle',
    failureReason: null,
  });
  assert.equal(logs.some((log) => log.message === 'runtime_sdk.start.failed'), false);
  assert.equal(logs.some((log) => log.message === 'runtime_sdk.stop.completed'), true);
  assert.equal(
    runtime.getDiagnostics().failures.some((failure) => failure.kind === 'startup_failure'),
    false,
  );
});

test('gateway runtime error during start is not overwritten by later connect completion', async () => {
  const connection = new FakeGatewayClient();
  const connectGate = createDeferred<void>();
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
    this.emitError({
      code: 'GATEWAY_FATAL',
      message: 'gateway_runtime_failed_during_start',
      retryable: false,
    });
    await connectGate.promise;
    this.state = 'READY';
    this.emitStatus();
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  const startPromise = runtime.start();
  await flushEvents();
  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'gateway_runtime_failed_during_start',
    error: new BridgeRuntimeError('gateway_unknown_error', 'gateway_runtime_failed_during_start'),
  });

  connectGate.resolve();
  await startPromise;

  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'gateway_runtime_failed_during_start',
    error: new BridgeRuntimeError('gateway_unknown_error', 'gateway_runtime_failed_during_start'),
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'gateway_runtime_failure',
    phase: 'runtime',
    message: 'gateway_runtime_failed_during_start',
    code: 'GATEWAY_FATAL',
  });
});

test('concurrent probe on one runtime creates one temporary connection', async () => {
  const connection = new FakeGatewayClient();
  let factoryCalls = 0;
  let connectCalls = 0;
  connection.connect = async function connect(): Promise<void> {
    connectCalls += 1;
    this.state = 'CONNECTING';
    this.emitStatus();
    await flushEvents();
    this.state = 'READY';
    this.emitStatus();
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

test('concurrent probe with different timeouts creates independent temporary connections', async () => {
  let factoryCalls = 0;
  let connectCalls = 0;
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), new FakeGatewayClient(), {
      connectionFactory: () => {
        factoryCalls += 1;
        const connection = new FakeGatewayClient();
        connection.connect = async function connect(): Promise<void> {
          connectCalls += 1;
          this.state = 'READY';
          this.emitStatus();
        };
        return connection;
      },
    }),
  );

  const [first, second] = await Promise.all([
    runtime.probe({ timeoutMs: 50 }),
    runtime.probe({ timeoutMs: 75 }),
  ]);

  assert.equal(factoryCalls, 2);
  assert.equal(connectCalls, 2);
  assert.equal(first.state, 'ready');
  assert.equal(second.state, 'ready');
});

test('probe during starting returns connecting without waiting for startPromise', async () => {
  const connection = new FakeGatewayClient();
  const connectGate = createDeferred<void>();
  let probeConnectionCreated = false;
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
    await connectGate.promise;
    this.state = 'READY';
    this.emitStatus();
  };
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), connection, {
      connectionFactory: () => {
        if (connection.state === 'CONNECTING') {
          probeConnectionCreated = true;
        }
        return connection;
      },
    }),
  );

  const startPromise = runtime.start();
  await flushEvents();
  const probeResult = await runtime.probe({ timeoutMs: 5_000 });
  connectGate.resolve();
  await startPromise;

  assert.deepEqual(probeResult, {
    state: 'connecting',
    latencyMs: probeResult.latencyMs,
    reason: 'runtime_lifecycle_busy_probe_skipped',
  });
  assert.equal(probeConnectionCreated, false);
});

test('probe during stopping returns connecting without temporary connection', async () => {
  const connection = new FakeGatewayClient();
  let disposeStarted = false;
  const disposeGate = createDeferred<void>();
  let factoryCalls = 0;
  const provider = createProvider();
  provider.dispose = async () => {
    disposeStarted = true;
    await disposeGate.promise;
  };
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(provider, connection, {
      connectionFactory: () => {
        factoryCalls += 1;
        return connection;
      },
    }),
  );

  await runtime.start();
  const stopPromise = runtime.stop();
  while (!disposeStarted) {
    await flushEvents();
  }
  const probeResult = await runtime.probe({ timeoutMs: 50 });
  disposeGate.resolve();
  await stopPromise;

  assert.deepEqual(probeResult, {
    state: 'connecting',
    latencyMs: probeResult.latencyMs,
    reason: 'runtime_lifecycle_busy_probe_skipped',
  });
  assert.equal(factoryCalls, 1);
});

test('start cancels in-flight probe before creating runtime connection', async () => {
  const probeConnection = new FakeGatewayClient();
  const runtimeConnection = new FakeGatewayClient();
  const createdConnections: string[] = [];
  let runtimeConnectCalls = 0;
  probeConnection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
  };
  runtimeConnection.connect = async function connect(): Promise<void> {
    runtimeConnectCalls += 1;
    this.state = 'READY';
    this.emitStatus();
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
  assert.equal(probeResult.reason, 'probe_cancelled_for_runtime_lifecycle');
  assert.equal(runtimeConnectCalls, 1);
  assert.equal(runtime.getStatus().state, 'ready');
});

test('start cancels same-tick in-flight probe before temporary probe becomes ready', async () => {
  const probeConnection = new FakeGatewayClient();
  const runtimeConnection = new FakeGatewayClient();
  const createdConnections: string[] = [];
  let runtimeConnectCalls = 0;
  probeConnection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
    await flushEvents();
    this.state = 'READY';
    this.emitStatus();
  };
  runtimeConnection.connect = async function connect(): Promise<void> {
    runtimeConnectCalls += 1;
    this.state = 'READY';
    this.emitStatus();
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
  await runtime.start();
  const probeResult = await probe;

  assert.deepEqual(createdConnections, ['probe', 'runtime']);
  assert.equal(probeResult.state, 'cancelled');
  assert.equal(probeResult.reason, 'probe_cancelled_for_runtime_lifecycle');
  assert.equal(runtimeConnectCalls, 1);
  assert.equal(runtime.getStatus().state, 'ready');
});

test('stop cancels in-flight probe without starting runtime lifecycle', async () => {
  const probeConnection = new FakeGatewayClient();
  probeConnection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
  };
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), probeConnection, {
      connectionFactory: () => probeConnection,
    }),
  );

  const probe = runtime.probe({ timeoutMs: 5_000 });
  await flushEvents();
  await runtime.stop();
  const probeResult = await probe;

  assert.equal(probeResult.state, 'cancelled');
  assert.equal(probeResult.reason, 'probe_cancelled_for_runtime_lifecycle');
  assert.deepEqual(runtime.getStatus(), {
    state: 'idle',
    failureReason: null,
  });
});

test('gateway probe returns cancelled for pre-aborted signal without creating connection', async () => {
  const controller = new AbortController();
  controller.abort(new Error('probe_pre_cancelled'));
  let factoryCalls = 0;
  const options = createRuntimeOptions(createProvider(), new FakeGatewayClient());
  const { observation } = createTestObservation();
  const driver = new GatewayProbeDriver({
    gatewayHost: options.gatewayHost,
    observation,
    connectionFactory: () => {
      factoryCalls += 1;
      return new FakeGatewayClient();
    },
  });

  const result = await driver.probe({
    timeoutMs: 5_000,
    abortSignal: controller.signal,
  });

  assert.deepEqual(result, {
    state: 'cancelled',
    latencyMs: result.latencyMs,
    reason: 'probe_pre_cancelled',
  });
  assert.equal(factoryCalls, 0);
});

test('gateway probe maps synchronous connect throw to result and disconnects connection', async () => {
  const connection = new FakeGatewayClient();
  let disconnectCalls = 0;
  connection.connect = function connect(): Promise<void> {
    throw new Error('gateway_websocket_error');
  };
  connection.disconnect = function disconnect(): void {
    disconnectCalls += 1;
    this.state = 'DISCONNECTED';
  };
  const options = createRuntimeOptions(createProvider(), connection);
  const { events, observation } = createTestObservation();
  const driver = new GatewayProbeDriver({
    gatewayHost: options.gatewayHost,
    observation,
    connectionFactory: () => connection,
  });

  const result = await driver.probe({ timeoutMs: 5_000 });

  assert.deepEqual(result, {
    state: 'connect_error',
    latencyMs: result.latencyMs,
    reason: 'gateway_websocket_error',
  });
  assert.equal(disconnectCalls, 1);
  assert.deepEqual(events.at(-1), {
    type: 'gateway_probe',
    phase: 'completed',
    gatewayUrl: options.gatewayHost.url,
    state: 'connect_error',
    latencyMs: result.latencyMs,
    reason: 'gateway_websocket_error',
  });
});

test('gateway probe maps connection factory throw to connect error result', async () => {
  const options = createRuntimeOptions(createProvider(), new FakeGatewayClient());
  const { events, observation } = createTestObservation();
  const driver = new GatewayProbeDriver({
    gatewayHost: options.gatewayHost,
    observation,
    connectionFactory: () => {
      throw new Error('probe_factory_failed');
    },
  });

  const result = await driver.probe({ timeoutMs: 5_000 });

  assert.deepEqual(result, {
    state: 'connect_error',
    latencyMs: result.latencyMs,
    reason: 'probe_factory_failed',
  });
  assert.deepEqual(events.at(-1), {
    type: 'gateway_probe',
    phase: 'completed',
    gatewayUrl: options.gatewayHost.url,
    state: 'connect_error',
    latencyMs: result.latencyMs,
    reason: 'probe_factory_failed',
  });
});

test('gateway probe ignores disconnect teardown failure after ready', async () => {
  const connection = new FakeGatewayClient();
  let disconnectCalls = 0;
  connection.connect = async function connect(): Promise<void> {
    this.state = 'READY';
    this.emitStatus();
  };
  connection.disconnect = function disconnect(): void {
    disconnectCalls += 1;
    throw new Error('probe_disconnect_cleanup_failed');
  };
  const options = createRuntimeOptions(createProvider(), connection);
  const { observation } = createTestObservation();
  const driver = new GatewayProbeDriver({
    gatewayHost: options.gatewayHost,
    observation,
    connectionFactory: () => connection,
  });

  const result = await driver.probe({ timeoutMs: 5_000 });

  assert.deepEqual(result, {
    state: 'ready',
    latencyMs: result.latencyMs,
    reason: 'probe_connected',
  });
  assert.equal(disconnectCalls, 1);
});

test('probe waits for connect rejection before classifying startup rejection', async () => {
  const connection = new FakeGatewayClient();
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emitStatus();
    this.state = 'DISCONNECTED';
    this.emitStatus();
    throw new GatewayClientError({
      code: 'GATEWAY_HANDSHAKE_REJECTED',
      disposition: 'startup_failure',
      retryable: false,
      message: 'gateway_register_rejected',
    });
  };

  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), connection, {
      connectionFactory: () => connection,
    }),
  );

  const result = await runtime.probe({ timeoutMs: 50 });

  assert.deepEqual(result, {
    state: 'rejected',
    latencyMs: result.latencyMs,
    reason: 'gateway_register_rejected',
  });
  assert.equal(result.latencyMs >= 0, true);
  assert.equal(runtime.getDiagnostics().failures.length, 0);
});

test('probe classifies gateway rejection by error code instead of message', async () => {
  const connection = new FakeGatewayClient();
  connection.connect = async function connect(): Promise<void> {
    throw new GatewayClientError({
      code: 'GATEWAY_HANDSHAKE_REJECTED',
      disposition: 'startup_failure',
      retryable: false,
      message: 'gateway_websocket_error',
    });
  };

  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), connection, {
      connectionFactory: () => connection,
    }),
  );

  const result = await runtime.probe({ timeoutMs: 50 });

  assert.deepEqual(result, {
    state: 'rejected',
    latencyMs: result.latencyMs,
    reason: 'gateway_websocket_error',
  });
});

test('probe connection factory failure resolves connect_error without diagnostics failure', async () => {
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), new FakeGatewayClient(), {
      connectionFactory: () => {
        throw new Error('probe_factory_failed');
      },
    }),
  );

  const result = await runtime.probe({ timeoutMs: 50 });

  assert.deepEqual(result, {
    state: 'connect_error',
    latencyMs: result.latencyMs,
    reason: 'probe_factory_failed',
  });
  assert.equal(runtime.getDiagnostics().failures.length, 0);
});
