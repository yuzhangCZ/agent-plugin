import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertValidMessageBridgeStatusSnapshot,
  createConnectingStatus,
  createReadyStatus,
  createUnavailableStatus,
} from '../../src/runtime/MessageBridgeStatus.ts';

describe('message bridge status helpers', () => {
  test('createConnectingStatus returns a valid connecting snapshot', () => {
    const snapshot = createConnectingStatus({
      updatedAt: 10,
      lastReadyAt: 5,
    });

    assertValidMessageBridgeStatusSnapshot(snapshot);
    assert.deepStrictEqual(snapshot, {
      connected: false,
      phase: 'connecting',
      unavailableReason: null,
      willReconnect: true,
      lastError: null,
      updatedAt: 10,
      lastReadyAt: 5,
    });
  });

  test('createReadyStatus returns a valid ready snapshot with aligned timestamps', () => {
    const snapshot = createReadyStatus({ updatedAt: 12 });

    assertValidMessageBridgeStatusSnapshot(snapshot);
    assert.strictEqual(snapshot.connected, true);
    assert.strictEqual(snapshot.phase, 'ready');
    assert.strictEqual(snapshot.unavailableReason, null);
    assert.strictEqual(snapshot.willReconnect, null);
    assert.strictEqual(snapshot.updatedAt, 12);
    assert.strictEqual(snapshot.lastReadyAt, 12);
  });

  test('createUnavailableStatus returns a valid unavailable snapshot', () => {
    const snapshot = createUnavailableStatus({
      reason: 'server_failure',
      lastError: 'device_conflict',
      updatedAt: 15,
      lastReadyAt: 12,
    });

    assertValidMessageBridgeStatusSnapshot(snapshot);
    assert.deepStrictEqual(snapshot, {
      connected: false,
      phase: 'unavailable',
      unavailableReason: 'server_failure',
      willReconnect: false,
      lastError: 'device_conflict',
      updatedAt: 15,
      lastReadyAt: 12,
    });
  });
});
