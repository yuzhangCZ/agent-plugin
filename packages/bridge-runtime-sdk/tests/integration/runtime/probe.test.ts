import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayClientError } from '@agent-plugin/gateway-client';
import { createBridgeRuntime } from '@/index.ts';
import type { BridgeGatewayHostConfig } from '@/index.ts';
import { GatewayProbeDriver } from '@/adapters/gateway/GatewayProbeDriver.ts';
import { DefaultRuntimeObservation } from '@/application/runtime-observation/index.ts';
import type { RuntimeObservationEvent } from '@/application/runtime-observation/index.ts';
import { createDeferred, createFakeRun, createProvider, createRuntimeOptions, FakeGatewayClient, flushEvents } from '../support/runtime-harness.ts';

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
