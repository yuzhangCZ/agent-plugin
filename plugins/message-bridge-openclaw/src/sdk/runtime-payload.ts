import { asRecord, asTrimmedString } from "../utils/type-guards.js";

export function pickRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return asRecord(value[key]) ?? undefined;
}

function hasOwnDefinedProperty(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
}

export function pickToolPayload(value: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (hasOwnDefinedProperty(value, key)) {
      return value[key];
    }
  }
  return undefined;
}

export function extractToolSessionIdFromRuntimePayload(payload: Record<string, unknown>): string | undefined {
  const metadata = pickRecord(payload, "metadata");
  const info = pickRecord(payload, "info");
  const session = pickRecord(payload, "session");
  const tool = pickRecord(payload, "tool");
  return (
    asTrimmedString(payload.toolSessionId) ??
    asTrimmedString(payload.sessionID) ??
    asTrimmedString(payload.sessionId) ??
    asTrimmedString(info?.id) ??
    asTrimmedString(session?.id) ??
    asTrimmedString(metadata?.toolSessionId) ??
    asTrimmedString(metadata?.sessionID) ??
    asTrimmedString(tool?.sessionID)
  );
}
