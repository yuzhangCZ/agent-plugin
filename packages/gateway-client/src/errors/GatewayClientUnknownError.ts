import type { GatewayConnectionDisposition } from '../domain/error-contract.ts';
import { GatewayClientError } from './GatewayClientError.ts';

function getUnknownErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : getUnknownValueMessage(error);
  return message.trim() ? message : 'unknown error';
}

function getUnknownValueMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof record.code === 'string' && record.code.trim()) {
      parts.push(`code=${record.code}`);
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      parts.push(`message=${record.message}`);
    }
    if (parts.length > 0) {
      return parts.join(' ');
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * gateway-client public API 边界捕获到的未知异常。
 * @remarks 保持 GatewayClientError 基类语义，同时集中 GATEWAY_UNKNOWN_ERROR 的默认字段。
 */
export class GatewayClientUnknownError extends GatewayClientError {
  constructor(input: {
    action: string;
    disposition: GatewayConnectionDisposition;
    cause: unknown;
  }) {
    super({
      code: 'GATEWAY_UNKNOWN_ERROR',
      disposition: input.disposition,
      retryable: false,
      message: `gateway client ${input.action} failed: ${getUnknownErrorMessage(input.cause)}`,
      cause: input.cause,
    });
    this.name = 'GatewayClientUnknownError';
  }
}
