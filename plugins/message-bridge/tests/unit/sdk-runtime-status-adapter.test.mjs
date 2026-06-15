import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSdkRuntimeStatusAdapter,
} from '../../src/runtime/SdkRuntimeStatusAdapter.ts';
import {
  __resetMessageBridgeStatusForTests,
  configureMessageBridgeStatusLogger,
  getMessageBridgeStatus,
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

describe('sdk runtime status adapter', () => {
  beforeEach(() => {
    __resetMessageBridgeStatusForTests();
  });

  test('maps runtime lifecycle and connection states to public snapshot', () => {
    const adapter = createSdkRuntimeStatusAdapter();

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

    adapter.publishRuntimeStatus({ state: 'ready', failureReason: null });
    const ready = getMessageBridgeStatus();
    assert.strictEqual(ready.connected, true);
    assert.strictEqual(ready.phase, 'ready');
    assert.strictEqual(ready.unavailableReason, null);
    assert.strictEqual(ready.willReconnect, null);
    assert.strictEqual(ready.lastError, null);
    assert.strictEqual(typeof ready.lastReadyAt, 'number');

    adapter.publishRuntimeStatus({ state: 'idle', failureReason: null });
    assert.deepStrictEqual(getMessageBridgeStatus(), ready);
  });

  test('publishes disabled, config invalid, server failure and plugin failure states', () => {
    const adapter = createSdkRuntimeStatusAdapter();

    adapter.publishDisabled('message_bridge_runtime_disabled');
    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'disabled');
    assert.strictEqual(getMessageBridgeStatus().lastError, 'message_bridge_runtime_disabled');

    adapter.publishConfigInvalid('invalid config');
    const configInvalid = getMessageBridgeStatus();
    assert.strictEqual(configInvalid.phase, 'unavailable');
    assert.strictEqual(configInvalid.unavailableReason, 'config_invalid');
    assert.strictEqual(configInvalid.willReconnect, false);
    assert.strictEqual(configInvalid.lastError, 'invalid config');

    adapter.publishRuntimeStatus({
      state: 'failed',
      failureReason: 'device_conflict',
      error: {
        code: 'gateway_handshake_rejected',
        message: 'device_conflict',
      },
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

  test('maps sdk gateway status error codes to message bridge unavailable reasons', () => {
    const adapter = createSdkRuntimeStatusAdapter();

    adapter.publishRuntimeStatus({
      state: 'failed',
      failureReason: 'register violated',
      error: {
        code: 'gateway_handshake_invalid',
        message: 'register violated',
      },
    });
    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'server_failure');

    __resetMessageBridgeStatusForTests();
    const anotherAdapter = createSdkRuntimeStatusAdapter();

    anotherAdapter.publishRuntimeStatus({
      state: 'failed',
      failureReason: 'timeout',
      error: {
        code: 'gateway_transport_error',
        message: 'timeout',
      },
    });
    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'network_failure');
  });

  test('keeps server failure precedence over later network failure', () => {
    const adapter = createSdkRuntimeStatusAdapter();

    adapter.publishRuntimeStatus({
      state: 'failed',
      failureReason: 'auth rejected',
      error: {
        code: 'gateway_handshake_rejected',
        message: 'auth rejected',
      },
    });

    adapter.publishRuntimeStatus({
      state: 'failed',
      failureReason: 'socket down',
      error: {
        code: 'gateway_transport_error',
        message: 'socket down',
      },
    });

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.unavailableReason, 'server_failure');
    assert.strictEqual(snapshot.lastError, 'auth rejected');
  });

  test('publishes network failure for transport-side gateway errors', () => {
    const adapter = createSdkRuntimeStatusAdapter();

    adapter.publishRuntimeStatus({ state: 'ready', failureReason: null });
    adapter.publishRuntimeStatus({
      state: 'failed',
      failureReason: 'network jitter',
      error: {
        code: 'gateway_transport_error',
        message: 'network jitter',
      },
    });

    const failed = getMessageBridgeStatus();
    assert.strictEqual(failed.phase, 'unavailable');
    assert.strictEqual(failed.unavailableReason, 'network_failure');
    assert.strictEqual(failed.willReconnect, false);
    assert.strictEqual(failed.lastError, 'network jitter');
  });

  test('non failed runtime statuses do not overwrite current ready snapshot except active lifecycle states', () => {
    const adapter = createSdkRuntimeStatusAdapter();

    adapter.publishRuntimeStatus({ state: 'ready', failureReason: null });
    const ready = getMessageBridgeStatus();

    adapter.publishRuntimeStatus({ state: 'idle', failureReason: null });

    assert.deepStrictEqual(getMessageBridgeStatus(), ready);
  });

  test('unknown sdk status error code publishes plugin_failure', () => {
    const adapter = createSdkRuntimeStatusAdapter();

    adapter.publishRuntimeStatus({
      state: 'failed',
      failureReason: 'gateway boom',
      error: {
        code: 'gateway_unknown_error',
        message: 'gateway boom',
      },
    });

    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'plugin_failure');
    assert.strictEqual(getMessageBridgeStatus().lastError, 'gateway boom');
  });

  test('failed runtime status without error publishes plugin_failure with stable message', () => {
    const adapter = createSdkRuntimeStatusAdapter();

    adapter.publishRuntimeStatus({
      state: 'failed',
      failureReason: null,
    });

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.phase, 'unavailable');
    assert.strictEqual(snapshot.unavailableReason, 'plugin_failure');
    assert.strictEqual(snapshot.lastError, 'unknown error');
  });

  test('startup parameter invalid is projected to config_invalid locally', () => {
    const adapter = createSdkRuntimeStatusAdapter();

    adapter.publishRuntimeStatus({
      state: 'failed',
      failureReason: 'invalid auth config',
      error: {
        code: 'gateway_connect_parameter_invalid',
        message: 'invalid auth config',
      },
    });

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.phase, 'unavailable');
    assert.strictEqual(snapshot.unavailableReason, 'config_invalid');
    assert.strictEqual(snapshot.lastError, 'invalid auth config');
  });

  test('publishing status through adapter does not log status api query noise', async () => {
    const logs = [];
    configureMessageBridgeStatusLogger(createLoggingClient(logs));
    const adapter = createSdkRuntimeStatusAdapter();

    adapter.publishConnecting();
    adapter.publishRuntimeStatus({ state: 'ready', failureReason: null });
    await flushLogs();

    assert.strictEqual(logs.filter((entry) => entry?.message === 'status_api.query').length, 0);
  });
});
