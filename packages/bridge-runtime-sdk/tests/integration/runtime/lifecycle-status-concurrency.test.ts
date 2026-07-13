import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeRuntimeError, createBridgeRuntime } from '@/index.ts';
import type { BridgeGatewayLogger, ThirdPartyAgentProvider } from '@/index.ts';
import { createDeferred, createFakeRun, createProvider, createRuntimeOptions, FakeGatewayClient, flushEvents } from '../support/runtime-harness.ts';

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
