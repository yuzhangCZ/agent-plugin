import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeManager } from '../src/runtime-manager.ts';

test('creates runtime once and returns safe snapshots', async () => {
  const manager = new RuntimeManager({
    createRuntime: async () => ({
      start: async () => undefined,
      stop: async () => undefined,
      probe: async () => ({ state: 'ready', latencyMs: 3 }),
      getStatus: () => ({ state: 'idle', failureReason: null }),
      getDiagnostics: () => ({
        lastReadyAt: null,
        lastInboundAt: null,
        lastOutboundAt: null,
        lastHeartbeatAt: null,
        providerCalls: [],
        facts: [],
        uplinks: [],
        terminals: [],
        interactions: [],
        derivedEvents: [],
        failures: [],
      }),
    }),
  });

  const result = await manager.create({
    url: 'ws://localhost:8081/ws/agent',
    auth: { ak: 'test-ak', sk: 'test-sk' },
    register: { channel: 'opencode', toolVersion: 'sdk-lab' },
  });

  assert.equal(result.status.state, 'idle');
  assert.equal(result.gateway.authLoaded, true);
  assert.equal(JSON.stringify(result).includes('test-sk'), false);
});

test('stops the previous runtime before replacing it', async () => {
  let stopCount = 0;
  const manager = new RuntimeManager({
    createRuntime: async () => ({
      start: async () => undefined,
      stop: async () => {
        stopCount += 1;
      },
      probe: async () => ({ state: 'ready', latencyMs: 3 }),
      getStatus: () => ({ state: 'idle', failureReason: null }),
      getDiagnostics: () => ({
        lastReadyAt: null,
        lastInboundAt: null,
        lastOutboundAt: null,
        lastHeartbeatAt: null,
        providerCalls: [],
        facts: [],
        uplinks: [],
        terminals: [],
        interactions: [],
        derivedEvents: [],
        failures: [],
      }),
    }),
  });

  const config = {
    url: 'ws://localhost:8081/ws/agent',
    auth: { ak: 'test-ak', sk: 'test-sk' },
    register: { channel: 'opencode', toolVersion: 'sdk-lab' },
  };

  await manager.create(config);
  await manager.create(config);

  assert.equal(stopCount, 1);
});

test('stops and clears runtime snapshot when gateway mode changes', async () => {
  let stopCount = 0;
  const manager = new RuntimeManager({
    createRuntime: async () => ({
      start: async () => undefined,
      stop: async () => {
        stopCount += 1;
      },
      probe: async () => ({ state: 'ready', latencyMs: 3 }),
      getStatus: () => ({ state: 'ready', failureReason: null }),
      getDiagnostics: () => ({
        gatewayState: 'ready',
        lastReadyAt: 1,
        lastInboundAt: null,
        lastOutboundAt: null,
        lastHeartbeatAt: null,
        providerCalls: [],
        facts: [],
        uplinks: [],
        terminals: [],
        interactions: [],
        derivedEvents: [],
        failures: [],
      }),
    }),
  });

  await manager.create({
    url: 'ws://localhost:8081/ws/agent',
    auth: { ak: 'test-ak', sk: 'test-sk' },
    register: { channel: 'opencode', toolVersion: 'sdk-lab' },
  });

  const snapshot = await manager.setMode('mock-gateway');

  assert.equal(stopCount, 1);
  assert.equal(snapshot.mode, 'mock-gateway');
  assert.equal(snapshot.gateway, undefined);
  assert.equal(snapshot.status, undefined);
  assert.equal(snapshot.diagnostics, undefined);
});

test('clears gateway downstream panel without clearing event stream', () => {
  const manager = new RuntimeManager();
  manager.events.append('sdk.log.info', '「onMessage」===>「{"type":"invoke","action":"chat","payload":{"toolSessionId":"tool-before"}}」');

  assert.equal(manager.snapshot().downstreams?.length, 1);

  const cleared = manager.clearGatewayDownstreams();

  assert.deepEqual(cleared.downstreams, []);
  assert.ok(cleared.events.length >= 2);

  manager.events.append('sdk.log.info', '「onMessage」===>「{"type":"invoke","action":"chat","payload":{"toolSessionId":"tool-after"}}」');

  const next = manager.snapshot().downstreams ?? [];
  assert.equal(next.length, 1);
  assert.equal(next[0]?.toolSessionId, 'tool-after');
});
