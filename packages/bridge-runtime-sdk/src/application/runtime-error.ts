export { BridgeRuntimeError, type BridgeRuntimeErrorCode } from '../public-contract.ts';
import { BridgeRuntimeError } from '../public-contract.ts';

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
