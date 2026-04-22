function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, raw) => {
      if (typeof raw === 'bigint') return raw.toString();
      if (raw instanceof Error) return { name: raw.name, message: raw.message, stack: raw.stack };
      if (raw && typeof raw === 'object') {
        if (seen.has(raw)) return '[Circular]';
        seen.add(raw);
      }
      return raw;
    });
  } catch {
    return String(value);
  }
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
  if (typeof payload === 'string') return payload;
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'number' || typeof payload === 'boolean' || typeof payload === 'bigint') return String(payload);
  if (payload instanceof ArrayBuffer) return `[binary ArrayBuffer byteLength=${payload.byteLength}]`;
  if (ArrayBuffer.isView(payload)) return `[binary ${payload.constructor.name} byteLength=${payload.byteLength}]`;
  if (typeof Blob !== 'undefined' && payload instanceof Blob) {
    return `[binary Blob size=${payload.size} type=${payload.type || 'application/octet-stream'}]`;
  }
  const json = safeStringify(payload);
  return json === undefined ? String(payload) : json;
}
