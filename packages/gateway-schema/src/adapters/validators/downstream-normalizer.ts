import type { DownstreamNormalizerPort } from '../../application/ports/downstream-normalizer-port.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import {
  DOWNSTREAM_MESSAGE_TYPES,
  INVOKE_ACTIONS,
  type InvokeAction,
} from '../../contract/literals/downstream.ts';
import {
  type GatewayDownstreamBusinessRequest,
  type InvokeMessage,
} from '../../contract/schemas/downstream.ts';
import type { Result } from '../../shared/result.ts';
import type { PlainObject, UnknownBoundaryInput } from '../../shared/boundary-types.ts';
import { zodErrorToWireViolation } from '../zod/zod-error-to-wire-violation.ts';
import {
  abortSessionInvokeSchema,
  chatInvokeSchema,
  closeSessionInvokeSchema,
  createSessionInvokeSchema,
  permissionReplyInvokeSchema,
  questionReplyInvokeSchema,
  statusQueryMessageSchema,
} from '../../contract/schemas/downstream.ts';
import { asString, fail, isRecord, ok, unsupportedAction, unsupportedMessage } from './shared.ts';

const [INVOKE_MESSAGE_TYPE, STATUS_QUERY_MESSAGE_TYPE] = DOWNSTREAM_MESSAGE_TYPES;
const [
  CHAT_ACTION,
  CREATE_SESSION_ACTION,
  CLOSE_SESSION_ACTION,
  PERMISSION_REPLY_ACTION,
  ABORT_SESSION_ACTION,
  QUESTION_REPLY_ACTION,
] = INVOKE_ACTIONS;

function normalizeInvokeMessage(message: PlainObject): Result<InvokeMessage, WireContractViolation> {
  const welinkSessionId = asString(message.welinkSessionId);
  const action = asString(message.action);

  if (!action) {
    return unsupportedAction('undefined', welinkSessionId);
  }

  if (!INVOKE_ACTIONS.includes(action as InvokeAction)) {
    return unsupportedAction(action, welinkSessionId);
  }

  switch (action as InvokeAction) {
    case CHAT_ACTION: {
      const parsed = chatInvokeSchema.safeParse(message);
      return parsed.success
        ? ok(parsed.data)
        : fail(
            zodErrorToWireViolation(parsed.error, {
              stage: 'payload',
              messageType: INVOKE_MESSAGE_TYPE,
              action,
              welinkSessionId,
            }).violation,
          );
    }
    case CREATE_SESSION_ACTION: {
      const parsed = createSessionInvokeSchema.safeParse(message);
      return parsed.success
        ? ok(parsed.data)
        : fail(
            zodErrorToWireViolation(parsed.error, {
              stage: 'payload',
              messageType: INVOKE_MESSAGE_TYPE,
              action,
              welinkSessionId,
            }).violation,
          );
    }
    case CLOSE_SESSION_ACTION: {
      const parsed = closeSessionInvokeSchema.safeParse(message);
      return parsed.success
        ? ok(parsed.data)
        : fail(
            zodErrorToWireViolation(parsed.error, {
              stage: 'payload',
              messageType: INVOKE_MESSAGE_TYPE,
              action,
              welinkSessionId,
            }).violation,
          );
    }
    case PERMISSION_REPLY_ACTION: {
      const parsed = permissionReplyInvokeSchema.safeParse(message);
      return parsed.success
        ? ok(parsed.data)
        : fail(
            zodErrorToWireViolation(parsed.error, {
              stage: 'payload',
              messageType: INVOKE_MESSAGE_TYPE,
              action,
              welinkSessionId,
            }).violation,
          );
    }
    case ABORT_SESSION_ACTION: {
      const parsed = abortSessionInvokeSchema.safeParse(message);
      return parsed.success
        ? ok(parsed.data)
        : fail(
            zodErrorToWireViolation(parsed.error, {
              stage: 'payload',
              messageType: INVOKE_MESSAGE_TYPE,
              action,
              welinkSessionId,
            }).violation,
          );
    }
    case QUESTION_REPLY_ACTION: {
      const parsed = questionReplyInvokeSchema.safeParse(message);
      return parsed.success
        ? ok(parsed.data)
        : fail(
            zodErrorToWireViolation(parsed.error, {
              stage: 'payload',
              messageType: INVOKE_MESSAGE_TYPE,
              action,
              welinkSessionId,
            }).violation,
          );
    }
    default:
      return unsupportedAction(action, welinkSessionId);
  }
}

export class DefaultDownstreamNormalizer implements DownstreamNormalizerPort {
  normalize(raw: UnknownBoundaryInput): Result<GatewayDownstreamBusinessRequest, WireContractViolation> {
    if (!isRecord(raw) || !asString(raw.type)) {
      return fail({
        stage: 'message',
        code: 'missing_required_field',
        field: 'type',
        message: 'type is required',
      });
    }

    if (raw.type === STATUS_QUERY_MESSAGE_TYPE) {
      const parsed = statusQueryMessageSchema.safeParse(raw);
      return parsed.success
        ? ok(parsed.data)
        : fail(zodErrorToWireViolation(parsed.error, { stage: 'message', messageType: STATUS_QUERY_MESSAGE_TYPE }).violation);
    }

    if (raw.type !== INVOKE_MESSAGE_TYPE) {
      return unsupportedMessage(asString(raw.type) ?? String(raw.type));
    }

    return normalizeInvokeMessage(raw);
  }
}
