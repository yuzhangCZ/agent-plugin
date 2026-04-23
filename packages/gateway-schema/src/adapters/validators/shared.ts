import { createWireViolation, type WireErrorCode, type WireViolation, type WireContractViolation } from '../../contract/errors/wire-errors.ts';
import { DOWNSTREAM_MESSAGE_TYPES } from '../../contract/literals/downstream.ts';
import type { Result } from '../../shared/result.ts';
import { isPlainObject, readLooseTrimmedStringPreservingEmpty, readTrimmedString } from '../../shared/type-guards.ts';
import type { PlainObject, UnknownBoundaryInput } from '../../shared/boundary-types.ts';

export type RecordLike = PlainObject;

const [INVOKE_MESSAGE_TYPE] = DOWNSTREAM_MESSAGE_TYPES;
const TOOL_EVENT_MESSAGE_TYPE = 'tool_event';

export function isRecord(value: UnknownBoundaryInput): value is RecordLike {
  return isPlainObject(value);
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function fail<T = never>(violation: WireViolation): Result<T, WireContractViolation> {
  const normalizedViolation =
    violation.stage === 'event'
      ? {
          ...violation,
          messageType: violation.messageType ?? violation.eventType,
          eventType: violation.eventType ?? violation.messageType,
        }
      : violation;
  return { ok: false, error: createWireViolation(normalizedViolation) };
}

export function makeViolation(params: WireViolation): WireViolation {
  return params;
}

export function asString(value: UnknownBoundaryInput): string | undefined {
  return readTrimmedString(value);
}

export function requireNonEmptyString(
  value: UnknownBoundaryInput,
  params: {
    stage: WireViolation['stage'];
    field: string;
    messageType?: string;
    action?: string;
    eventType?: string;
    welinkSessionId?: string;
    toolSessionId?: string;
    expected?: string;
  },
): Result<string, WireContractViolation> {
  const normalized = asString(value);
  if (!normalized) {
    return fail({
      stage: params.stage,
      code: 'missing_required_field',
      field: params.field,
      message: `${params.field} is required`,
      messageType: params.messageType,
      action: params.action,
      eventType: params.eventType,
      welinkSessionId: params.welinkSessionId,
      toolSessionId: params.toolSessionId,
    });
  }
  return ok(normalized);
}

export function requireStringPreservingEmpty(
  value: UnknownBoundaryInput,
  params: {
    stage: WireViolation['stage'];
    field: string;
    messageType?: string;
    action?: string;
    eventType?: string;
    welinkSessionId?: string;
    toolSessionId?: string;
    expected?: string;
  },
): Result<string, WireContractViolation> {
  if (value === undefined) {
    return fail({
      stage: params.stage,
      code: 'missing_required_field',
      field: params.field,
      message: `${params.field} is required`,
      messageType: params.messageType,
      action: params.action,
      eventType: params.eventType,
      welinkSessionId: params.welinkSessionId,
      toolSessionId: params.toolSessionId,
    });
  }

  const normalized = readLooseTrimmedStringPreservingEmpty(value);
  if (normalized === undefined) {
    return invalidFieldType({
      stage: params.stage,
      field: params.field,
      expected: params.expected ?? 'a string',
      messageType: params.messageType,
      action: params.action,
      eventType: params.eventType,
      welinkSessionId: params.welinkSessionId,
      toolSessionId: params.toolSessionId,
    });
  }

  return ok(normalized);
}

export function invalidFieldType(
  params: {
    stage: WireViolation['stage'];
    field: string;
    expected: string;
    messageType?: string;
    action?: string;
    eventType?: string;
    welinkSessionId?: string;
    toolSessionId?: string;
    code?: WireErrorCode;
  },
): Result<never, WireContractViolation> {
  return fail({
    stage: params.stage,
    code: params.code ?? 'invalid_field_type',
    field: params.field,
    message: `${params.field} must be ${params.expected}`,
    messageType: params.messageType,
    action: params.action,
    eventType: params.eventType,
    welinkSessionId: params.welinkSessionId,
    toolSessionId: params.toolSessionId,
  });
}

export function unsupportedMessage(
  messageType: string,
  stage: WireViolation['stage'] = 'message',
): Result<never, WireContractViolation> {
  return fail({
    stage,
    code: 'unsupported_message',
    field: 'type',
    message: `Unsupported message type: ${messageType}`,
    messageType,
  });
}

export function unsupportedAction(
  action: string,
  welinkSessionId?: string,
): Result<never, ReturnType<typeof createWireViolation>> {
  return fail({
    stage: 'payload',
    code: 'unsupported_action',
    field: 'action',
    message: `Unsupported downstream action: ${action}`,
    messageType: INVOKE_MESSAGE_TYPE,
    action,
    welinkSessionId,
  });
}

export function unsupportedEventType(eventType: string): Result<never, ReturnType<typeof createWireViolation>> {
  return fail({
    stage: 'event',
    code: 'unsupported_event_type',
    field: 'type',
    message: `Unsupported upstream event type: ${eventType}`,
    messageType: TOOL_EVENT_MESSAGE_TYPE,
    eventType,
  });
}
