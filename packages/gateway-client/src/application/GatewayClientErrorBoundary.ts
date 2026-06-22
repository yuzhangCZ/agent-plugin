import type { GatewayConnectionDisposition } from '../domain/error-contract.ts';
import { GatewayClientError } from '../errors/GatewayClientError.ts';
import { GatewayClientUnknownError } from '../errors/GatewayClientUnknownError.ts';

/**
 * gateway-client public facade 的异常边界。
 * @remarks 只在对外入口使用，确保未知异常不会以普通 Error 或裸值泄漏给调用方。
 */
export function toUnknownGatewayClientError(
  error: unknown,
  action: string,
  disposition: GatewayConnectionDisposition,
): GatewayClientError {
  if (error instanceof GatewayClientError) {
    return error;
  }
  return new GatewayClientUnknownError({
    action,
    disposition,
    cause: error,
  });
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function';
}

export function guardGatewayClientOperation(
  action: string,
  disposition: GatewayConnectionDisposition,
  operation: () => Promise<void>,
): Promise<void>;
export function guardGatewayClientOperation<T>(
  action: string,
  disposition: GatewayConnectionDisposition,
  operation: () => T,
): T;
export function guardGatewayClientOperation<T>(
  action: string,
  disposition: GatewayConnectionDisposition,
  operation: () => T | Promise<T>,
): T | Promise<T> {
  try {
    const result = operation();
    if (isPromiseLike(result)) {
      return Promise.resolve(result).catch((error: unknown) => {
        throw toUnknownGatewayClientError(error, action, disposition);
      });
    }
    return result;
  } catch (error) {
    throw toUnknownGatewayClientError(error, action, disposition);
  }
}
