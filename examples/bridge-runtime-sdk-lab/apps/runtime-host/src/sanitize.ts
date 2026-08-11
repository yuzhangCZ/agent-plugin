const SENSITIVE_KEYS = new Set([
  'ak',
  'sk',
  'token',
  'authorization',
  'cookie',
  'secret',
  'password',
  'content',
  'text',
  'answers',
]);

export function sanitizeForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDisplay(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = sanitizeForDisplay(nestedValue);
  }
  return output;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
