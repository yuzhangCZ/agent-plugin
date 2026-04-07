import {
  DOWNSTREAM_MESSAGE_TYPES,
  INVOKE_ACTIONS,
  normalizeDownstream as normalizeSharedDownstream,
  type WireContractViolation,
} from '@agent-plugin/gateway-wire-v1';

import { asRecord, asTrimmedString, hasOwn, type PlainObject } from '../utils/type-guards.js';
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

function createCompatibilityError(params: {
  code: DownstreamNormalizationError['code'];
  field: string;
  message: string;
  messageType?: string;
  action?: string;
  welinkSessionId?: string;
}): DownstreamNormalizationError {
  return {
    stage: params.messageType ? 'payload' : 'message',
    code: params.code,
    field: params.field,
    message: params.message,
    messageType: params.messageType,
    action: params.action,
    welinkSessionId: params.welinkSessionId,
  };
}

function prevalidateCompatibility(raw: unknown): DownstreamNormalizationError | null {
  const message = asRecord(raw);
  if (!message || message.type !== DOWNSTREAM_MESSAGE_TYPE.INVOKE) {
    return null;
  }

  const action = asTrimmedString(message.action);
  const welinkSessionId = asTrimmedString(message.welinkSessionId);
  const payload = asRecord(message.payload);

  if (action === undefined) {
    return createCompatibilityError({
      code: 'missing_required_field',
      field: 'action',
      message: 'action is required',
      messageType: DOWNSTREAM_MESSAGE_TYPE.INVOKE,
      welinkSessionId,
    });
  }

  if (
    (action === INVOKE_ACTION.CHAT || action === INVOKE_ACTION.CREATE_SESSION) &&
    payload &&
    hasOwn(payload, 'assistantId') &&
    typeof payload.assistantId !== 'string'
  ) {
    return createCompatibilityError({
      code: 'invalid_field_type',
      field: 'payload.assistantId',
      message: 'payload.assistantId must be a string',
      messageType: DOWNSTREAM_MESSAGE_TYPE.INVOKE,
      action,
      welinkSessionId,
    });
  }

  if (
    action === INVOKE_ACTION.CREATE_SESSION &&
    typeof message.welinkSessionId === 'string' &&
    !message.welinkSessionId.trim()
  ) {
    return createCompatibilityError({
      code: 'missing_required_field',
      field: 'welinkSessionId',
      message: 'welinkSessionId is required',
      messageType: DOWNSTREAM_MESSAGE_TYPE.INVOKE,
      action,
      welinkSessionId: message.welinkSessionId,
    });
  }

  return null;
}

function remapAssistantIdInput(raw: unknown): unknown {
  const message = asRecord(raw);
  if (!message || message.type !== DOWNSTREAM_MESSAGE_TYPE.INVOKE) {
    return raw;
  }

  const payload = asRecord(message.payload);
  if (!payload) {
    return raw;
  }

  if (!hasOwn(payload, 'assiantId')) {
    return raw;
  }

  const { assiantId: _legacyAssistantId, ...restPayload } = payload;
  return {
    ...message,
    payload: restPayload,
  };
}

function remapAssistantIdOutput(message: NormalizedDownstreamMessage): NormalizedDownstreamMessage {
  return message;
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
  const compatibilityError = prevalidateCompatibility(raw);
  if (compatibilityError) {
    if (logger) {
      logDownstreamNormalizationFailure(logger, raw, compatibilityError);
    }
    return { ok: false, error: compatibilityError };
  }

  const result = normalizeSharedDownstream(remapAssistantIdInput(raw));
  if (!result.ok) {
    const error = toNormalizationError(result.error);
    if (logger) {
      logDownstreamNormalizationFailure(logger, raw, error);
    }
    return { ok: false, error };
  }

  return {
    ok: true,
    value: remapAssistantIdOutput(
      result.value.type === DOWNSTREAM_MESSAGE_TYPE.INVOKE && !('welinkSessionId' in result.value)
        ? { ...result.value, welinkSessionId: undefined }
        : (result.value as NormalizedDownstreamMessage),
    ),
  };
}

export const normalizeDownstream = normalizeDownstreamMessage;
