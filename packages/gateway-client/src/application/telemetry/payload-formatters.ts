function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, raw) => {
      if (typeof raw === 'bigint') {
        return raw.toString();
      }
      if (raw instanceof Error) {
        return { ...raw, name: raw.name, message: raw.message, stack: raw.stack };
      }
      if (raw && typeof raw === 'object') {
        if (seen.has(raw)) {
          return '[Circular]';
        }
        seen.add(raw);
      }
      return raw;
    });
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function readProperty(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function addSnapshotField(
  snapshot: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): boolean {
  if (!(key in source)) {
    return false;
  }
  const value = readProperty(source, key);
  if (value === undefined) {
    return false;
  }
  snapshot[key] = value;
  return true;
}

function summarizeEventTarget(target: unknown): Record<string, unknown> | undefined {
  if (!isRecord(target)) {
    return undefined;
  }

  const summary: Record<string, unknown> = {};
  let hasValue = false;
  for (const key of ['readyState', 'url', 'protocol', 'extensions', 'bufferedAmount'] as const) {
    hasValue = addSnapshotField(summary, target, key) || hasValue;
  }

  return hasValue ? summary : undefined;
}

// DOM Event / ErrorEvent / CloseEvent 的关键字段大多是不可枚举属性，直接 JSON.stringify 会丢失。
function enrichEventLikePayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  const enriched: Record<string, unknown> = { ...payload };
  for (const key of ['type', 'message', 'code', 'reason', 'wasClean', 'isTrusted'] as const) {
    const value = readProperty(payload, key);
    if (value !== undefined && !(key in enriched)) {
      enriched[key] = value;
    }
  }

  const error = readProperty(payload, 'error');
  if (error !== undefined && !('error' in enriched)) {
    enriched.error = error;
  }

  const targetSummary = summarizeEventTarget(readProperty(payload, 'target'));
  if (targetSummary && !('target' in enriched)) {
    enriched.target = targetSummary;
  }

  const currentTargetSummary = summarizeEventTarget(readProperty(payload, 'currentTarget'));
  if (currentTargetSummary && !('currentTarget' in enriched)) {
    enriched.currentTarget = currentTargetSummary;
  }

  const constructorName = typeof payload.constructor?.name === 'string' ? payload.constructor.name : undefined;
  if (constructorName && constructorName !== 'Object' && !('rawType' in enriched)) {
    enriched.rawType = constructorName;
  }

  return enriched;
}

/**
 * 安全序列化任意值，避免循环引用导致日志崩溃。
 */
export function safeStringify(value: unknown): string {
  return safeJsonStringify(value);
}

/**
 * 将原始帧载荷格式化为可读日志字符串。
 */
export function formatRawPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload === null || payload === undefined) {
    return '';
  }
  if (typeof payload === 'number' || typeof payload === 'boolean' || typeof payload === 'bigint') {
    return String(payload);
  }
  if (payload instanceof ArrayBuffer) {
    return `[binary ArrayBuffer byteLength=${payload.byteLength}]`;
  }
  if (ArrayBuffer.isView(payload)) {
    return `[binary ${payload.constructor.name} byteLength=${payload.byteLength}]`;
  }
  if (typeof Blob !== 'undefined' && payload instanceof Blob) {
    return `[binary Blob size=${payload.size} type=${payload.type || 'application/octet-stream'}]`;
  }
  const json = safeStringify(enrichEventLikePayload(payload));
  return json === undefined ? String(payload) : json;
}
