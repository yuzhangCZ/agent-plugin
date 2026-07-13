import assert from 'node:assert/strict';
import test from 'node:test';

import { GatewayClientError } from '@agent-plugin/gateway-client';

import { RuntimeLifecycleService } from '@/application/lifecycle/RuntimeLifecycleService.ts';
import { BridgeRuntimeError } from '@/application/runtime-error.ts';

class RecordingObservation {
  readonly events: Array<{ method: string; args: unknown[] }> = [];

  runtimeStartRequested(...args: unknown[]): void {
    this.events.push({ method: 'runtimeStartRequested', args });
  }

  runtimeStartCompleted(...args: unknown[]): void {
    this.events.push({ method: 'runtimeStartCompleted', args });
  }

  runtimeStartFailed(...args: unknown[]): void {
    this.events.push({ method: 'runtimeStartFailed', args });
  }

  runtimeStopRequested(...args: unknown[]): void {
    this.events.push({ method: 'runtimeStopRequested', args });
  }

  runtimeStopCompleted(...args: unknown[]): void {
    this.events.push({ method: 'runtimeStopCompleted', args });
  }

  runtimeStopFailed(...args: unknown[]): void {
    this.events.push({ method: 'runtimeStopFailed', args });
  }

  failureRecorded(...args: unknown[]): void {
    this.events.push({ method: 'failureRecorded', args });
  }
}

function createCore(input: {
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
} = {}) {
  const calls = { start: 0, stop: 0 };
  return {
    calls,
    core: {
      async start() {
        calls.start += 1;
        await input.start?.();
      },
      async stop() {
        calls.stop += 1;
        await input.stop?.();
      },
      async handleCommand() {
        return 'query_status' as const;
      },
    },
  };
}

function createDriver(input: {
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  ready?: boolean;
} = {}) {
  const calls = { connect: 0, disconnect: 0 };
  let ready = input.ready ?? false;
  return {
    calls,
    driver: {
      attach() {},
      async connect() {
        calls.connect += 1;
        await input.connect?.();
        ready = true;
      },
      async disconnect() {
        calls.disconnect += 1;
        await input.disconnect?.();
        ready = false;
      },
      getStatus() {
        return { state: ready ? 'ready' : 'idle' };
      },
      send() {},
      isReady() {
        return ready;
      },
    },
  };
}

function createDeferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

test('RuntimeLifecycleService starts core and gateway once for concurrent start calls', async () => {
  const { core, calls: coreCalls } = createCore();
  const { driver, calls: driverCalls } = createDriver();
  const observation = new RecordingObservation();
  const service = new RuntimeLifecycleService(core as never, driver as never, observation as never);

  await Promise.all([service.start(), service.start()]);

  assert.equal(coreCalls.start, 1);
  assert.equal(driverCalls.connect, 1);
  assert.deepEqual(service.getStatus(), { state: 'ready', failureReason: null });
  assert.deepEqual(observation.events.map((event) => event.method), [
    'runtimeStartRequested',
    'runtimeStartCompleted',
  ]);
});

test('RuntimeLifecycleService disconnects gateway and stops core when stopping a ready runtime', async () => {
  const { core, calls: coreCalls } = createCore();
  const { driver, calls: driverCalls } = createDriver();
  const observation = new RecordingObservation();
  const service = new RuntimeLifecycleService(core as never, driver as never, observation as never);

  await service.start();
  await service.stop();

  assert.equal(driverCalls.disconnect, 1);
  assert.equal(coreCalls.stop, 1);
  assert.deepEqual(service.getStatus(), { state: 'idle', failureReason: null });
  assert.equal(observation.events.some((event) => event.method === 'runtimeStopCompleted'), true);
});

test('RuntimeLifecycleService waits for in-flight stop before reconnecting', async () => {
  const stopStarted = createDeferred();
  const stopGate = createDeferred();
  const { core, calls: coreCalls } = createCore({
    async stop() {
      stopStarted.resolve();
      await stopGate.promise;
    },
  });
  const { driver, calls: driverCalls } = createDriver();
  const observation = new RecordingObservation();
  const service = new RuntimeLifecycleService(core as never, driver as never, observation as never);
  await service.start();

  const stopPromise = service.stop();
  await stopStarted.promise;
  const startPromise = service.start();
  await Promise.resolve();

  assert.equal(coreCalls.start, 1);
  assert.equal(driverCalls.connect, 1);

  stopGate.resolve();
  await Promise.all([stopPromise, startPromise]);

  assert.equal(coreCalls.start, 2);
  assert.equal(driverCalls.connect, 2);
  assert.deepEqual(service.getStatus(), { state: 'ready', failureReason: null });
});

test('RuntimeLifecycleService maps provider start failure into failed runtime status', async () => {
  const { core } = createCore({
    async start() {
      throw new Error('provider unavailable');
    },
  });
  const { driver } = createDriver();
  const observation = new RecordingObservation();
  const service = new RuntimeLifecycleService(core as never, driver as never, observation as never);

  await assert.rejects(
    () => service.start(),
    (error) => error instanceof BridgeRuntimeError && error.code === 'provider_unavailable',
  );

  const status = service.getStatus();
  assert.equal(status.state, 'failed');
  assert.equal(status.error?.code, 'provider_unavailable');
  assert.equal(observation.events.some((event) => event.method === 'runtimeStartFailed'), true);
});

test('RuntimeLifecycleService maps non-cancelled gateway closed status into failed runtime status', async () => {
  const { core } = createCore();
  const { driver } = createDriver();
  const observation = new RecordingObservation();
  const service = new RuntimeLifecycleService(core as never, driver as never, observation as never);
  await service.start();

  service.handleGatewayStatusChanged({
    isReady: () => false,
    isReconnecting: () => false,
    isFailureClosed: () => true,
    getError: () => new GatewayClientError({
      code: 'gateway_transport_error',
      disposition: 'failed',
      retryable: false,
      message: 'transport closed',
    }),
  } as never);

  const status = service.getStatus();
  assert.equal(status.state, 'failed');
  assert.equal(status.error?.code, 'gateway_transport_error');
  assert.equal(observation.events.some((event) => event.method === 'failureRecorded'), true);
});
