import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayClientError } from '@agent-plugin/gateway-client';
import { BridgeRuntimeError, createBridgeRuntime } from '@/index.ts';
import { GatewayRuntimeDriver } from '@/adapters/gateway/GatewayRuntimeDriver.ts';
import { DefaultRuntimeObservation } from '@/application/runtime-observation/index.ts';
import type { RuntimeObservationEvent } from '@/application/runtime-observation/index.ts';
import { createDeferred, createFakeRun, createProvider, createRuntimeOptions, FakeGatewayClient, flushEvents } from '../support/runtime-harness.ts';

function assertBridgeRuntimeError(
  error: unknown,
  expected: { code: BridgeRuntimeError['code']; message: string },
): void {
  assert.equal(error instanceof Error, true);
  assert.equal((error as Error).name, 'BridgeRuntimeError');
  assert.equal((error as BridgeRuntimeError).code, expected.code);
  assert.equal((error as Error).message, expected.message);
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
