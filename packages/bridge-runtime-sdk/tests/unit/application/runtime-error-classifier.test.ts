import assert from 'node:assert/strict';
import test from 'node:test';

import { GatewayClientError } from '@agent-plugin/gateway-client';
import { BridgeRuntimeError } from '@/index.ts';
import {
  fromGatewayClosedFailure,
  fromGatewayConnectFailure,
  fromProbeFailure,
  fromProviderStartFailure,
  fromRuntimeInternalFailure,
} from '@/application/runtime-error-classifier.ts';

function assertBridgeRuntimeError(
  error: unknown,
  expected: { code: BridgeRuntimeError['code']; message: string },
): void {
  assert.equal(error instanceof Error, true);
  assert.equal((error as Error).name, 'BridgeRuntimeError');
  assert.equal((error as BridgeRuntimeError).code, expected.code);
  assert.equal((error as Error).message, expected.message);
}

test('runtime error classifier owns lifecycle gateway and fallback mappings', () => {
  assertBridgeRuntimeError(fromGatewayConnectFailure(new GatewayClientError({
    code: 'GATEWAY_HANDSHAKE_REJECTED',
    disposition: 'startup_failure',
    retryable: false,
    message: 'rejected',
  })), {
    code: 'gateway_handshake_rejected',
    message: 'rejected',
  });
  assertBridgeRuntimeError(fromGatewayConnectFailure(new GatewayClientError({
    code: 'GATEWAY_NOT_READY',
    disposition: 'runtime_failure',
    retryable: false,
    message: 'not ready',
  })), {
    code: 'gateway_unknown_error',
    message: 'not ready',
  });
  assertBridgeRuntimeError(fromGatewayConnectFailure({
    code: 'GATEWAY_HANDSHAKE_REJECTED',
    message: 'plain object is not gateway client error',
  }), {
    code: 'gateway_unknown_error',
    message: 'plain object is not gateway client error',
  });
  assertBridgeRuntimeError(fromProviderStartFailure(new Error('provider failed')), {
    code: 'provider_unavailable',
    message: 'provider failed',
  });
  assertBridgeRuntimeError(fromRuntimeInternalFailure(new Error('cleanup failed')), {
    code: 'runtime_internal_error',
    message: 'cleanup failed',
  });
  assertBridgeRuntimeError(fromRuntimeInternalFailure(new GatewayClientError({
    code: 'GATEWAY_TRANSPORT_ERROR',
    disposition: 'runtime_failure',
    retryable: false,
    message: 'cleanup gateway failure',
  })), {
    code: 'runtime_internal_error',
    message: 'cleanup gateway failure',
  });
  assertBridgeRuntimeError(fromProbeFailure(new Error('probe failed')), {
    code: 'probe_unknown_error',
    message: 'probe failed',
  });
  assert.equal(fromGatewayClosedFailure(new GatewayClientError({
    code: 'GATEWAY_CLOSED_MANUAL',
    disposition: 'cancelled',
    retryable: false,
    message: 'manual',
  })), null);
  assert.equal(fromGatewayClosedFailure(new GatewayClientError({
    code: 'GATEWAY_CONNECT_ABORTED',
    disposition: 'cancelled',
    retryable: false,
    message: 'aborted',
  })), null);

  const existing = new BridgeRuntimeError('runtime_internal_error', 'already classified');
  assert.equal(fromRuntimeInternalFailure(existing), existing);
});
