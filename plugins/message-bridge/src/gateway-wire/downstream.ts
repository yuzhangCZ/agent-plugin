import {
  DOWNSTREAM_MESSAGE_TYPES,
  INVOKE_ACTIONS,
  normalizeDownstream as normalizeSharedDownstream,
  type WireContractViolation,
} from '@agent-plugin/gateway-wire-v1';

import { asRecord, asTrimmedString, type PlainObject } from '../utils/type-guards.js';
import type { BridgeLogger } from '../runtime/AppLogger.js';
import type {
  DownstreamNormalizationError,
  NormalizeResult,
  NormalizedDownstreamMessage,
} from '../protocol/downstream/DownstreamMessageTypes.js';

export * from '@agent-plugin/gateway-wire-v1';
export type {
  DownstreamNormalizationError,
  NormalizeResult,
  NormalizedDownstreamMessage,
  NormalizedInvokeMessage,
} from '../protocol/downstream/DownstreamMessageTypes.js';

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

function toNormalizationError(error: WireContractViolation): DownstreamNormalizationError {
  return {
    stage: error.violation.stage === 'message' || error.violation.stage === 'payload'
      ? error.violation.stage
      : 'payload',
    code:
      error.violation.code === 'unsupported_message' ||
      error.violation.code === 'unsupported_action' ||
      error.violation.code === 'missing_required_field'
        ? error.violation.code
        : 'invalid_field_type',
    field: error.violation.field,
    message: error.violation.message,
    messageType: error.violation.messageType,
    action: error.violation.action,
    welinkSessionId: error.violation.welinkSessionId,
  };
}

export function logDownstreamNormalizationFailure(
  logger: Pick<BridgeLogger, 'warn'>,
  raw: unknown,
  error: DownstreamNormalizationError,
): void {
  logger.warn('downstream.normalization_failed', {
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

export function normalizeDownstreamMessage(
  raw: unknown,
  logger?: Pick<BridgeLogger, 'warn'>,
): NormalizeResult<NormalizedDownstreamMessage> {
  const result = normalizeSharedDownstream(raw);
  if (!result.ok) {
    const error = toNormalizationError(result.error);
    if (logger) {
      logDownstreamNormalizationFailure(logger, raw, error);
    }
    return { ok: false, error };
  }

  return {
    ok: true,
    value:
      result.value.type === DOWNSTREAM_MESSAGE_TYPE.INVOKE && !('welinkSessionId' in result.value)
        ? { ...result.value, welinkSessionId: undefined }
        : (result.value as NormalizedDownstreamMessage),
  };
}

export const normalizeDownstream = normalizeDownstreamMessage;
