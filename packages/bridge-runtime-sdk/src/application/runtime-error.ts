export type BridgeRuntimeErrorCode =
  | 'runtime_start_failed'
  | 'runtime_stop_failed'
  | 'runtime_probe_failed'
  | 'runtime_gateway_error';

/**
 * Bridge runtime public API 抛出的稳定错误结构。
 */
export class BridgeRuntimeError extends Error {
  override readonly name = 'BridgeRuntimeError';
  readonly code: BridgeRuntimeErrorCode;

  constructor(code: BridgeRuntimeErrorCode, message: string) {
    super(message);
    this.code = code;
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

export function createBridgeRuntimeError(code: BridgeRuntimeErrorCode, error: unknown): BridgeRuntimeError {
  if (error instanceof BridgeRuntimeError && error.code === code) {
    return error;
  }
  return new BridgeRuntimeError(code, normalizeErrorMessage(error));
}
