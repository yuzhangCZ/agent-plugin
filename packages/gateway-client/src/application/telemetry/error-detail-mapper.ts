import { GatewayClientError } from '../../errors/GatewayClientError.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof GatewayClientError) {
    return {
      code: error.code,
      category: error.category,
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
