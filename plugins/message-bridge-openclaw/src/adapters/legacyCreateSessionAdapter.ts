import type { CreateSessionPayload } from "../contracts/downstream.js";
import { asTrimmedString, isPlainObject } from "../utils/type-guards.js";

export interface LegacyCreateSessionPayloadAdapterResult {
  payload: CreateSessionPayload;
  requestedSessionId?: string;
}

export function normalizeLegacyCreateSessionPayload(payload: unknown): LegacyCreateSessionPayloadAdapterResult {
  if (!isPlainObject(payload)) {
    return { payload: {} };
  }

  return {
    payload: {
      sessionId: asTrimmedString(payload.sessionId),
      metadata: isPlainObject(payload.metadata) ? payload.metadata : undefined,
    },
    requestedSessionId: asTrimmedString(payload.sessionId),
  };
}
