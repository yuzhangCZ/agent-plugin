import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetMessageBridgeStatusForTests,
  configureMessageBridgeStatusLogger,
  getMessageBridgeStatus,
  publishMessageBridgeStatus,
  resetMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from '../../src/runtime/MessageBridgeStatusStore.ts';

function createLoggingClient(logs) {
  return {
    app: {
      log: async (options) => {
        logs.push(options?.body);
        return true;
      },
    },
  };
}

async function flushLogs() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('message bridge status store', () => {
  beforeEach(() => {
    __resetMessageBridgeStatusForTests();
  });

  test('defaults to unavailable and uninitialized', () => {
    const snapshot = getMessageBridgeStatus();

    assert.strictEqual(snapshot.connected, false);
    assert.strictEqual(snapshot.phase, 'unavailable');
    assert.strictEqual(snapshot.unavailableReason, 'uninitialized');
    assert.strictEqual(snapshot.willReconnect, false);
    assert.strictEqual(snapshot.lastError, null);
    assert.strictEqual(snapshot.lastReadyAt, null);
    assert.strictEqual(typeof snapshot.updatedAt, 'number');
  });

  test('subscribe returns unsubscribe and emits semantic changes once', () => {
    const seen = [];
    const unsubscribe = subscribeMessageBridgeStatus((snapshot) => {
      seen.push(snapshot);
    });

    assert.strictEqual(typeof unsubscribe, 'function');

    publishMessageBridgeStatus({
      connected: false,
      phase: 'connecting',
      unavailableReason: null,
      willReconnect: true,
      lastError: null,
      updatedAt: 10,
      lastReadyAt: null,
    });

    publishMessageBridgeStatus({
      connected: false,
      phase: 'connecting',
      unavailableReason: null,
      willReconnect: true,
      lastError: null,
      updatedAt: 11,
      lastReadyAt: null,
    });

    unsubscribe();

    publishMessageBridgeStatus({
      connected: true,
      phase: 'ready',
      unavailableReason: null,
      willReconnect: null,
      lastError: null,
      updatedAt: 12,
      lastReadyAt: 12,
    });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].phase, 'connecting');
  });

  test('logs query snapshot when status api is read', async () => {
    const logs = [];
    configureMessageBridgeStatusLogger(createLoggingClient(logs));

    const snapshot = getMessageBridgeStatus();
    await flushLogs();

    const queryLogs = logs.filter((entry) => entry?.message === 'status_api.query');
    assert.strictEqual(queryLogs.length, 1);
    assert.strictEqual(queryLogs[0].level, 'info');
    assert.strictEqual(queryLogs[0].extra.phase, snapshot.phase);
    assert.strictEqual(queryLogs[0].extra.connected, snapshot.connected);
    assert.strictEqual(queryLogs[0].extra.unavailableReason, snapshot.unavailableReason);
    assert.strictEqual(queryLogs[0].extra.willReconnect, snapshot.willReconnect);
    assert.strictEqual(queryLogs[0].extra.updatedAt, snapshot.updatedAt);
  });

  test('logs subscribe and unsubscribe with listener count', async () => {
    const logs = [];
    configureMessageBridgeStatusLogger(createLoggingClient(logs));

    const unsubscribe = subscribeMessageBridgeStatus(() => {});
    unsubscribe();
    await flushLogs();

    const subscribeLogs = logs.filter((entry) => entry?.message === 'status_api.subscribe');
    const unsubscribeLogs = logs.filter((entry) => entry?.message === 'status_api.unsubscribe');
    assert.strictEqual(subscribeLogs.length, 1);
    assert.strictEqual(unsubscribeLogs.length, 1);
    assert.strictEqual(subscribeLogs[0].extra.listenerCount, 1);
    assert.strictEqual(unsubscribeLogs[0].extra.listenerCount, 0);
  });

  test('logs semantic status changes and suppresses duplicates', async () => {
    const logs = [];
    configureMessageBridgeStatusLogger(createLoggingClient(logs));

    publishMessageBridgeStatus({
      connected: false,
      phase: 'connecting',
      unavailableReason: null,
      willReconnect: true,
      lastError: null,
      updatedAt: 10,
      lastReadyAt: null,
    });

    publishMessageBridgeStatus({
      connected: false,
      phase: 'connecting',
      unavailableReason: null,
      willReconnect: true,
      lastError: null,
      updatedAt: 11,
      lastReadyAt: null,
    });

    await flushLogs();

    const changedLogs = logs.filter((entry) => entry?.message === 'status_api.changed');
    assert.strictEqual(changedLogs.length, 1);
    assert.strictEqual(changedLogs[0].extra.fromPhase, 'unavailable');
    assert.strictEqual(changedLogs[0].extra.toPhase, 'connecting');
    assert.strictEqual(changedLogs[0].extra.fromConnected, false);
    assert.strictEqual(changedLogs[0].extra.toConnected, false);
    assert.strictEqual(changedLogs[0].extra.fromUnavailableReason, 'uninitialized');
    assert.strictEqual(changedLogs[0].extra.toUnavailableReason, null);
    assert.strictEqual(changedLogs[0].extra.fromWillReconnect, false);
    assert.strictEqual(changedLogs[0].extra.toWillReconnect, true);
  });

  test('enforces snapshot invariants', () => {
    assert.throws(() => publishMessageBridgeStatus({
      connected: true,
      phase: 'ready',
      unavailableReason: 'disabled',
      willReconnect: null,
      lastError: null,
      updatedAt: 10,
      lastReadyAt: 10,
    }), /message_bridge_status_invalid_snapshot/);

    assert.throws(() => publishMessageBridgeStatus({
      connected: false,
      phase: 'unavailable',
      unavailableReason: null,
      willReconnect: false,
      lastError: null,
      updatedAt: 10,
      lastReadyAt: null,
    }), /message_bridge_status_invalid_snapshot/);
  });

  test('reset notifies subscribers when semantics fall back to default snapshot', () => {
    const seen = [];
    subscribeMessageBridgeStatus((snapshot) => {
      seen.push(snapshot);
    });

    publishMessageBridgeStatus({
      connected: true,
      phase: 'ready',
      unavailableReason: null,
      willReconnect: null,
      lastError: null,
      updatedAt: 10,
      lastReadyAt: 10,
    });

    const resetSnapshot = resetMessageBridgeStatus();

    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[1].phase, 'unavailable');
    assert.strictEqual(seen[1].unavailableReason, 'uninitialized');
    assert.strictEqual(seen[1].willReconnect, false);
    assert.deepStrictEqual(resetSnapshot, seen[1]);
  });
});
