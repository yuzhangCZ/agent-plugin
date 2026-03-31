import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetMessageBridgeStatusForTests,
  getMessageBridgeStatus,
  publishMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from '../../src/runtime/MessageBridgeStatusStore.ts';

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
});
