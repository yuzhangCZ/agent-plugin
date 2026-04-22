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

    adapter.publishGatewayState('READY');
    const ready = getMessageBridgeStatus();
    assert.strictEqual(ready.connected, true);
    assert.strictEqual(ready.phase, 'ready');
    assert.strictEqual(ready.unavailableReason, null);
    assert.strictEqual(ready.willReconnect, null);
    assert.strictEqual(ready.lastError, null);
    assert.strictEqual(typeof ready.lastReadyAt, 'number');

    adapter.publishGatewayState('DISCONNECTED');
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

    adapter.publishGatewayError({
      code: 'GATEWAY_REGISTER_REJECTED',
      source: 'handshake',
      phase: 'before_ready',
      retryable: false,
      message: 'device_conflict',
    });
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

  test('uses gateway-client translator semantics for handshake and transport failures', () => {
    const adapter = createBridgeRuntimeStatusAdapter();

    adapter.publishGatewayError({
      code: 'GATEWAY_PROTOCOL_VIOLATION',
      source: 'handshake',
      phase: 'before_ready',
      retryable: false,
      message: 'register violated',
    });
    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'server_failure');

    adapter.publishGatewayError({
      code: 'GATEWAY_CONNECT_TIMEOUT',
      source: 'transport',
      phase: 'before_open',
      retryable: true,
      message: 'timeout',
    });
    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'server_failure');
  });

  test('keeps server failure precedence over later network failure', () => {
    const adapter = createBridgeRuntimeStatusAdapter();

    adapter.publishGatewayError({
      code: 'GATEWAY_REGISTER_REJECTED',
      source: 'handshake',
      phase: 'before_ready',
      retryable: false,
      message: 'auth rejected',
    });

    adapter.publishGatewayError({
      code: 'GATEWAY_WEBSOCKET_ERROR',
      source: 'transport',
      phase: 'ready',
      retryable: true,
      message: 'socket down',
    });

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.unavailableReason, 'server_failure');
    assert.strictEqual(snapshot.lastError, 'auth rejected');
  });

  test('publishes network failure for transport-side gateway errors', () => {
    const adapter = createBridgeRuntimeStatusAdapter();

    adapter.publishGatewayState('READY');
    adapter.publishGatewayError({
      code: 'GATEWAY_UNEXPECTED_CLOSE',
      source: 'transport',
      phase: 'ready',
      retryable: true,
      message: 'network jitter',
    });

    const failed = getMessageBridgeStatus();
    assert.strictEqual(failed.phase, 'unavailable');
    assert.strictEqual(failed.unavailableReason, 'network_failure');
    assert.strictEqual(failed.willReconnect, false);
    assert.strictEqual(failed.lastError, 'network jitter');
  });

  test('state gate errors do not overwrite current public snapshot', () => {
    const adapter = createBridgeRuntimeStatusAdapter();

    adapter.publishGatewayState('READY');
    const ready = getMessageBridgeStatus();

    adapter.publishGatewayError({
      code: 'GATEWAY_NOT_READY',
      source: 'state_gate',
      phase: 'before_ready',
      retryable: false,
      message: 'not ready',
    });

    assert.deepStrictEqual(getMessageBridgeStatus(), ready);
  });

  test('protocol diagnostic errors do not overwrite current public snapshot', () => {
    const adapter = createBridgeRuntimeStatusAdapter();

    adapter.publishGatewayState('READY');
    const ready = getMessageBridgeStatus();

    adapter.publishGatewayError({
      code: 'GATEWAY_PROTOCOL_VIOLATION',
      source: 'inbound_protocol',
      phase: 'ready',
      retryable: false,
      message: 'unexpected frame',
    });

    assert.deepStrictEqual(getMessageBridgeStatus(), ready);
  });
});
