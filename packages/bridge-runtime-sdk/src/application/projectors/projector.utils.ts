export function toOptionalNumericRecord(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
