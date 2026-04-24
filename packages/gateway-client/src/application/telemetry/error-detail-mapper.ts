import { GatewayClientError } from '../../errors/GatewayClientError.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * 将未知错误对象归一化为可日志化的 message。
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 将未知错误对象归一化为结构化 detail 字段。
 */
export function getErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof GatewayClientError) {
    return {
      code: error.code,
      source: error.source,
      phase: error.phase,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof Error) {
    return {
      errorDetail: error.message,
      errorName: error.name,
      errorType: error.name,
      rawType: error.constructor.name,
    };
  }
  if (isRecord(error)) {
    const rawType = typeof error.constructor?.name === 'string' ? error.constructor.name : 'Object';
    return {
      ...(typeof error.message === 'string' && error.message.trim() ? { errorDetail: error.message } : {}),
      ...(typeof error.type === 'string' && error.type.trim() ? { errorType: error.type } : {}),
      rawType,
    };
  }
  return { errorDetail: String(error) };
}

/**
 * 提取 WebSocket error event 的结构化细节。
 */
export function extractWebSocketErrorDetails(event: unknown): Record<string, unknown> {
  const record = isRecord(event) ? event : undefined;
  if (!record) return getErrorDetails(event);
  const details = record.error !== undefined && record.error !== event ? getErrorDetails(record.error) : getErrorDetails(event);
  if (typeof record.type === 'string') details.eventType = record.type;
  if (!details.errorDetail && typeof record.message === 'string' && record.message.trim()) {
    details.errorDetail = record.message;
  }
  const target = isRecord(record.target) ? record.target : undefined;
  if (typeof target?.readyState === 'number') details.readyState = target.readyState;
  return details;
}
