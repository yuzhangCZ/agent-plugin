import {
  DOWNSTREAM_MESSAGE_TYPES,
  INVOKE_ACTIONS,
  normalizeDownstream as normalizeSharedDownstream,
  type WireContractViolation,
} from "@agent-plugin/gateway-schema";

import { normalizeLegacyCreateSessionPayload } from "../adapters/legacyCreateSessionAdapter.js";
import type { BridgeLogger } from "../types.js";
import type { DownstreamMessage, InvokeMessage } from "../contracts/downstream.js";
import { asRecord, asTrimmedString, hasOwn, type PlainObject } from "../utils/type-guards.js";

export * from "../contracts/downstream.js";

export interface DownstreamNormalizationError {
  code: "unsupported_message" | "unsupported_action" | "missing_required_field" | "invalid_payload";
  message: string;
  stage: "message" | "payload";
  field: string;
  messageType?: string;
  action?: string;
  welinkSessionId?: string;
}

export type NormalizeResult<T> = { ok: true; value: T } | { ok: false; error: DownstreamNormalizationError };

export const DOWNSTREAM_MESSAGE_TYPE = {
  INVOKE: DOWNSTREAM_MESSAGE_TYPES[0],
  STATUS_QUERY: DOWNSTREAM_MESSAGE_TYPES[1],
} as const;

export const INVOKE_ACTION = {
  CHAT: INVOKE_ACTIONS[0],
  CREATE_SESSION: INVOKE_ACTIONS[1],
  CLOSE_SESSION: INVOKE_ACTIONS[2],
  PERMISSION_REPLY: INVOKE_ACTIONS[3],
  ABORT_SESSION: INVOKE_ACTIONS[4],
  QUESTION_REPLY: INVOKE_ACTIONS[5],
} as const;

function buildMessagePreview(raw: unknown): PlainObject {
  const message = asRecord(raw);
  if (!message) {
    return { kind: typeof raw };
  }

  return {
    type: asTrimmedString(message.type),
    keys: Object.keys(message).slice(0, 8),
  };
}

function prevalidateCompatibility(raw: unknown): DownstreamNormalizationError | null {
  const message = asRecord(raw);
  if (
    !message ||
    message.type !== DOWNSTREAM_MESSAGE_TYPE.INVOKE ||
    message.action !== INVOKE_ACTION.QUESTION_REPLY ||
    !asRecord(message.payload)
  ) {
    return null;
  }

  const payload = asRecord(message.payload)!;
  if (hasOwn(payload, "toolCallId") && typeof payload.toolCallId === "string" && !payload.toolCallId.trim()) {
    return {
      code: "invalid_payload",
      message: "question_reply toolCallId must be a non-empty string when provided",
      stage: "payload",
      field: "payload.toolCallId",
      messageType: DOWNSTREAM_MESSAGE_TYPE.INVOKE,
      action: INVOKE_ACTION.QUESTION_REPLY,
      welinkSessionId: asTrimmedString(message.welinkSessionId),
    };
  }

  return null;
}

function toNormalizationError(error: WireContractViolation): DownstreamNormalizationError {
  return {
    code:
      error.violation.code === "unsupported_message" ||
      error.violation.code === "unsupported_action" ||
      error.violation.code === "missing_required_field"
        ? error.violation.code
        : "invalid_payload",
    message: error.violation.message,
    stage: error.violation.stage === "message" ? "message" : "payload",
    field: error.violation.field,
    messageType: error.violation.messageType,
    action: error.violation.action,
    welinkSessionId: error.violation.welinkSessionId,
  };
}

export function logDownstreamNormalizationFailure(
  logger: BridgeLogger | undefined,
  raw: unknown,
  error: DownstreamNormalizationError,
): void {
  if (!logger) {
    return;
  }

  logger.warn("downstream.normalization_failed", {
    stage: error.stage,
    errorCode: error.code,
    field: error.field,
    message: error.message,
    messageType: error.messageType,
    action: error.action,
    welinkSessionId: error.welinkSessionId,
    messagePreview: buildMessagePreview(raw),
  });
}

function mapCreateSessionPayload(raw: unknown, message: InvokeMessage): InvokeMessage {
  if (message.action !== INVOKE_ACTION.CREATE_SESSION) {
    return message;
  }

  const rawMessage = asRecord(raw);
  const payload = rawMessage ? normalizeLegacyCreateSessionPayload(rawMessage.payload).payload : {};
  return {
    ...message,
    payload,
  };
}

export function normalizeDownstreamMessage(
  raw: unknown,
  logger?: BridgeLogger,
): NormalizeResult<DownstreamMessage> {
  const compatibilityError = prevalidateCompatibility(raw);
  if (compatibilityError) {
    logDownstreamNormalizationFailure(logger, raw, compatibilityError);
    return { ok: false, error: compatibilityError };
  }

  const result = normalizeSharedDownstream(raw);
  if (!result.ok) {
    const error = toNormalizationError(result.error);
    logDownstreamNormalizationFailure(logger, raw, error);
    return { ok: false, error };
  }

  if (result.value.type === DOWNSTREAM_MESSAGE_TYPE.STATUS_QUERY) {
    return { ok: true, value: result.value };
  }

  return {
    ok: true,
    value: mapCreateSessionPayload(raw, result.value as InvokeMessage),
  };
}

export { normalizeDownstreamMessage as normalizeDownstream };
