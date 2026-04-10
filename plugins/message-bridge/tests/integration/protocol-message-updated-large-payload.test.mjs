import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { WebSocketServer } from 'ws';

import { createGatewayClient } from '@agent-plugin/gateway-client';
import { EventFilter } from '../../src/event/EventFilter.ts';
import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts';
import { createLargeMessageUpdatedEvent } from '../fixtures/opencode-events/message.updated.large-summary.fixture.mjs';

function createGatewayLogger() {
  const entries = [];

  const createLogger = (base = {}) => ({
    debug(message, extra = {}) {
      entries.push({ level: 'debug', message, extra: { ...base, ...extra } });
    },
    info(message, extra = {}) {
      entries.push({ level: 'info', message, extra: { ...base, ...extra } });
    },
    warn(message, extra = {}) {
      entries.push({ level: 'warn', message, extra: { ...base, ...extra } });
    },
    error(message, extra = {}) {
      entries.push({ level: 'error', message, extra: { ...base, ...extra } });
    },
    child(extra = {}) {
      return createLogger({ ...base, ...extra });
    },
    getTraceId() {
      return 'integration-large-message-updated';
    },
  });

  return {
    entries,
    logger: createLogger({ component: 'gateway-test' }),
  };
}

async function createGatewayServer({ maxPayload } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    path: '/ws/agent',
    ...(typeof maxPayload === 'number' ? { maxPayload } : {}),
  });
  const receivedMessages = [];
  const closeEvents = [];

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      receivedMessages.push(parsed);
      if (parsed.type === 'register') {
        ws.send(JSON.stringify({ type: 'register_ok' }));
      }
    });

    ws.on('close', (code, reason) => {
      closeEvents.push({
        code,
        reason: reason.toString(),
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    receivedMessages,
    closeEvents,
    async close() {
      await new Promise((resolve) => wss.close(() => server.close(resolve)));
    },
  };
}

async function waitFor(predicate, timeoutMs = 2000, intervalMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function createConnectedHarness({ maxPayload } = {}) {
  const gateway = await createGatewayServer({ maxPayload });
  const { entries, logger } = createGatewayLogger();
  const runtime = new BridgeRuntime({ client: {} });
  const connection = createGatewayClient({
    url: `ws://127.0.0.1:${gateway.port}/ws/agent`,
    debug: true,
    registerMessage: {
      type: 'register',
      deviceName: 'integration-test',
      macAddress: '00:00:00:00:00:00',
      os: 'darwin',
      toolType: 'opencode',
      toolVersion: '1.2.24',
    },
    logger,
  });

  runtime.gatewayConnection = connection;
  runtime.eventFilter = new EventFilter(['message.updated']);
  connection.on('stateChange', (state) => {
    runtime.stateManager.setState(state);
  });

  await connection.connect();
  await waitFor(() => connection.getState() === 'READY');

  return {
    runtime,
    connection,
    gateway,
    gatewayLogs: entries,
  };
}

const cleanupTasks = [];

after(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    await task?.();
  }
});

describe('protocol message.updated large payload regression', () => {
  test('projects oversized message.updated before websocket send', async () => {
    const harness = await createConnectedHarness();
    cleanupTasks.push(async () => {
      harness.connection.disconnect();
      await harness.gateway.close();
    });

    const event = createLargeMessageUpdatedEvent();
    await harness.runtime.handleEvent(event);

    await waitFor(() =>
      harness.gateway.receivedMessages.some((message) => message.type === 'tool_event'),
    );

    const toolEvent = harness.gateway.receivedMessages.find((message) => message.type === 'tool_event');
    assert.ok(toolEvent);
    assert.strictEqual(toolEvent.event.type, 'message.updated');
    assert.deepStrictEqual(toolEvent.event.properties.info.summary.diffs, [
      {
        file: 'logs/local-stack/ai-gateway.log',
        status: 'modified',
        additions: 829,
        deletions: 0,
      },
      {
        file: 'logs/local-stack/skill-server.log',
        status: 'modified',
        additions: 398,
        deletions: 0,
      },
    ]);
    assert.ok(!('before' in toolEvent.event.properties.info.summary.diffs[0]));
    assert.ok(!('after' in toolEvent.event.properties.info.summary.diffs[0]));
    assert.ok(!('before' in toolEvent.event.properties.info.summary.diffs[1]));
    assert.ok(!('after' in toolEvent.event.properties.info.summary.diffs[1]));

    const gatewaySendLog = harness.gatewayLogs.find(
      (entry) => entry.message === 'gateway.send' && entry.extra.eventType === 'message.updated',
    );
    assert.ok(gatewaySendLog);
    assert.ok(gatewaySendLog.extra.originalPayloadBytes > 1024 * 1024);
    assert.ok(gatewaySendLog.extra.transportPayloadBytes < 256 * 1024);
    assert.ok(
      gatewaySendLog.extra.transportPayloadBytes / gatewaySendLog.extra.originalPayloadBytes < 0.2,
    );
  });

  test('keeps connection ready under 1KB websocket maxPayload after projection', async () => {
    const harness = await createConnectedHarness({ maxPayload: 1024 });
    cleanupTasks.push(async () => {
      harness.connection.disconnect();
      await harness.gateway.close();
    });

    await harness.runtime.handleEvent(createLargeMessageUpdatedEvent());

    await waitFor(() =>
      harness.gateway.receivedMessages.some((message) => message.type === 'tool_event'),
    );

    const toolEvent = harness.gateway.receivedMessages.find((message) => message.type === 'tool_event');
    assert.ok(toolEvent);
    assert.strictEqual(Buffer.byteLength(JSON.stringify(toolEvent), 'utf8') < 1024, true);
    assert.deepStrictEqual(harness.gateway.closeEvents, []);
    assert.strictEqual(harness.connection.getState(), 'READY');
    assert.strictEqual(
      harness.gatewayLogs.some((entry) => entry.message === 'gateway.close'),
      false,
    );
    assert.strictEqual(
      harness.gatewayLogs.some((entry) => entry.message === 'gateway.reconnect.scheduled'),
      false,
    );
    assert.strictEqual(
      harness.gatewayLogs.some((entry) => entry.message === 'gateway.reconnect.attempt'),
      false,
    );
    assert.strictEqual(
      harness.gatewayLogs.some((entry) => entry.message === 'gateway.reconnect.failed'),
      false,
    );
  });
});
