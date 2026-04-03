import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBridgeRuntimeStatusAdapter,
} from '../../src/runtime/BridgeRuntimeStatusAdapter.ts';
import {
  __resetMessageBridgeStatusForTests,
  getMessageBridgeStatus,
} from '../../src/runtime/MessageBridgeStatusStore.ts';

describe('bridge runtime status adapter', () => {
  beforeEach(() => {
    __resetMessageBridgeStatusForTests();
  });

  test('maps runtime lifecycle and connection states to public snapshot', () => {
    const adapter = createBridgeRuntimeStatusAdapter();

    adapter.publishConnecting();
    assert.deepStrictEqual(getMessageBridgeStatus(), {
      connected: false,
      phase: 'connecting',
      unavailableReason: null,
      willReconnect: true,
      lastError: null,
      updatedAt: getMessageBridgeStatus().updatedAt,
      lastReadyAt: null,
    });

    adapter.publishConnectionState('READY');
    const ready = getMessageBridgeStatus();
    assert.strictEqual(ready.connected, true);
    assert.strictEqual(ready.phase, 'ready');
    assert.strictEqual(ready.unavailableReason, null);
    assert.strictEqual(ready.willReconnect, null);
    assert.strictEqual(ready.lastError, null);
    assert.strictEqual(typeof ready.lastReadyAt, 'number');

    adapter.publishConnectionState('DISCONNECTED');
    assert.deepStrictEqual(getMessageBridgeStatus(), ready);
  });

  test('publishes disabled, config invalid, server failure and plugin failure states', () => {
    const adapter = createBridgeRuntimeStatusAdapter();

    adapter.publishDisabled();
    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'disabled');

    adapter.publishConfigInvalid('invalid config');
    const configInvalid = getMessageBridgeStatus();
    assert.strictEqual(configInvalid.phase, 'unavailable');
    assert.strictEqual(configInvalid.unavailableReason, 'config_invalid');
    assert.strictEqual(configInvalid.willReconnect, false);
    assert.strictEqual(configInvalid.lastError, 'invalid config');

    adapter.publishServerFailure('device_conflict');
    const rejected = getMessageBridgeStatus();
    assert.strictEqual(rejected.unavailableReason, 'server_failure');
    assert.strictEqual(rejected.willReconnect, false);
    assert.strictEqual(rejected.lastError, 'device_conflict');

    adapter.publishPluginFailure('startup boom');
    const failed = getMessageBridgeStatus();
    assert.strictEqual(failed.unavailableReason, 'plugin_failure');
    assert.strictEqual(failed.willReconnect, false);
    assert.strictEqual(failed.lastError, 'startup boom');
  });

  test('publishes server_failure when server closes without reconnect', () => {
    const adapter = createBridgeRuntimeStatusAdapter();

    adapter.publishConnectionState('READY');
    adapter.publishConnectionClosed({
      opened: true,
      manuallyDisconnected: false,
      aborted: false,
      rejected: true,
      code: 4403,
      reason: 'server shutdown',
      wasClean: true,
      willReconnect: false,
    });

    const closed = getMessageBridgeStatus();
    assert.strictEqual(closed.phase, 'unavailable');
    assert.strictEqual(closed.unavailableReason, 'server_failure');
    assert.strictEqual(closed.willReconnect, false);
    assert.strictEqual(closed.lastError, 'server shutdown');
  });

  test('publishes server_failure when handshake is rejected before open', () => {
    const adapter = createBridgeRuntimeStatusAdapter();

    adapter.publishConnectionClosed({
      opened: false,
      manuallyDisconnected: false,
      aborted: false,
      rejected: true,
      code: 4403,
      reason: 'auth rejected',
      wasClean: true,
      willReconnect: false,
    });

    const closed = getMessageBridgeStatus();
    assert.strictEqual(closed.phase, 'unavailable');
    assert.strictEqual(closed.unavailableReason, 'server_failure');
    assert.strictEqual(closed.willReconnect, false);
    assert.strictEqual(closed.lastError, 'auth rejected');
  });

  test('publishes network_failure when connect fails without rejection evidence', () => {
    const adapter = createBridgeRuntimeStatusAdapter();

    adapter.publishConnectFailure('connect timeout');

    const failed = getMessageBridgeStatus();
    assert.strictEqual(failed.phase, 'unavailable');
    assert.strictEqual(failed.unavailableReason, 'network_failure');
    assert.strictEqual(failed.willReconnect, false);
    assert.strictEqual(failed.lastError, 'connect timeout');
  });

  test('publishes connecting when connection closes but runtime will reconnect', () => {
    const adapter = createBridgeRuntimeStatusAdapter();

    adapter.publishConnectionState('READY');
    adapter.publishConnectionClosed({
      opened: true,
      manuallyDisconnected: false,
      aborted: false,
      rejected: false,
      code: 1006,
      reason: 'network jitter',
      wasClean: false,
      willReconnect: true,
    });

    const reconnecting = getMessageBridgeStatus();
    assert.strictEqual(reconnecting.connected, false);
    assert.strictEqual(reconnecting.phase, 'connecting');
    assert.strictEqual(reconnecting.unavailableReason, null);
    assert.strictEqual(reconnecting.willReconnect, true);
    assert.strictEqual(reconnecting.lastError, null);
  });
});
