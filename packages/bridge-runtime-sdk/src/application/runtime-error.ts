export type BridgeRuntimeErrorCode =
  | 'gateway_connect_parameter_invalid'
  | 'gateway_auth_rejected'
  | 'gateway_handshake_timeout'
  | 'gateway_handshake_rejected'
  | 'gateway_handshake_invalid'
  | 'gateway_transport_error'
  | 'gateway_reconnect_exhausted'
  | 'gateway_unknown_error'
  | 'provider_unavailable'
  | 'runtime_internal_error'
  | 'runtime_unknown_error'
  | 'probe_unknown_error';

/**
 * Bridge runtime public API 抛出的稳定错误结构。
 */
export class BridgeRuntimeError extends Error {
  override readonly name = 'BridgeRuntimeError';
  readonly code: BridgeRuntimeErrorCode;

  constructor(code: BridgeRuntimeErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

export function normalizeErrorMessage(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function cloneBridgeRuntimeError(error: BridgeRuntimeError): BridgeRuntimeError {
  return new BridgeRuntimeError(error.code, error.message);
}
