import { GatewayClientError } from '@agent-plugin/gateway-client';
import {
  BridgeRuntimeError,
  normalizeErrorMessage,
  type BridgeRuntimeErrorCode,
} from './runtime-error.ts';

const bridgeRuntimeGatewayErrorCodes = new Set<BridgeRuntimeErrorCode>([
  'gateway_connect_parameter_invalid',
  'gateway_auth_rejected',
  'gateway_handshake_timeout',
  'gateway_handshake_rejected',
  'gateway_handshake_invalid',
  'gateway_transport_error',
  'gateway_reconnect_exhausted',
  'gateway_unknown_error',
]);

function isBridgeRuntimeGatewayErrorCode(code: string): code is BridgeRuntimeErrorCode {
  return bridgeRuntimeGatewayErrorCodes.has(code as BridgeRuntimeErrorCode);
}

function fromGatewayClientError(error: GatewayClientError): BridgeRuntimeError {
  const loweredCode = error.code.toLowerCase();
  return new BridgeRuntimeError(
    isBridgeRuntimeGatewayErrorCode(loweredCode) ? loweredCode : 'gateway_unknown_error',
    error.message,
  );
}

function toRuntimeError(
  error: unknown,
  fallbackCode: BridgeRuntimeErrorCode,
  options: { mapGatewayClientError?: boolean } = {},
): BridgeRuntimeError {
  if (error instanceof BridgeRuntimeError) {
    return error;
  }
  if (options.mapGatewayClientError !== false && error instanceof GatewayClientError) {
    return fromGatewayClientError(error);
  }
  return new BridgeRuntimeError(fallbackCode, normalizeErrorMessage(error));
}

export function fromProviderStartFailure(error: unknown): BridgeRuntimeError {
  return toRuntimeError(error, 'provider_unavailable');
}

export function fromGatewayConnectFailure(error: unknown): BridgeRuntimeError {
  return toRuntimeError(error, 'gateway_unknown_error');
}

export function fromGatewayClosedFailure(error: unknown): BridgeRuntimeError | null {
  if (!(error instanceof GatewayClientError) || error.disposition === 'cancelled') {
    return null;
  }
  return fromGatewayClientError(error);
}

export function fromRuntimeInternalFailure(error: unknown): BridgeRuntimeError {
  return toRuntimeError(error, 'runtime_internal_error', { mapGatewayClientError: false });
}

export function fromProbeFailure(error: unknown): BridgeRuntimeError {
  return toRuntimeError(error, 'probe_unknown_error');
}
