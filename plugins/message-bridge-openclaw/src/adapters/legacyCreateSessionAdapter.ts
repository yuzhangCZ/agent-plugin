import type { CreateSessionPayload } from "../contracts/downstream.js";
import { isPlainObject } from "../utils/type-guards.js";

export interface LegacyCreateSessionPayloadAdapterResult {
  payload: CreateSessionPayload;
}

export function normalizeLegacyCreateSessionPayload(payload: unknown): LegacyCreateSessionPayloadAdapterResult {
  if (!isPlainObject(payload)) {
    return { payload: {} };
  }

  return {
    // legacy sessionId 只在兼容层被吸收，不再进入新的会话身份语义。
    payload: {
      metadata: isPlainObject(payload.metadata) ? payload.metadata : undefined,
    },
  };
}
