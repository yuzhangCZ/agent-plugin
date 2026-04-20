import type { PlainObject, UnknownBoundaryInput } from './boundary-types.ts';

export function isPlainObject(value: UnknownBoundaryInput): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOwn(record: PlainObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function readPlainObject(value: UnknownBoundaryInput): PlainObject | undefined {
  return isPlainObject(value) ? value : undefined;
}

export function readArray(value: UnknownBoundaryInput): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function readString(value: UnknownBoundaryInput): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function readTrimmedString(value: UnknownBoundaryInput): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

export function readNumber(value: UnknownBoundaryInput): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(value: UnknownBoundaryInput): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function readEnumValue<const T extends readonly string[]>(
  value: UnknownBoundaryInput,
  supportedValues: T,
): T[number] | undefined {
  return typeof value === 'string' && supportedValues.includes(value as T[number])
    ? (value as T[number])
    : undefined;
}
