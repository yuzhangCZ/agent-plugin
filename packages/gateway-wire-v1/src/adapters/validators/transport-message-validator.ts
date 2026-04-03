import { z } from 'zod';
import type { TransportMessageValidatorPort } from '../../application/ports/transport-message-validator-port.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import { requiredTrimmedString } from '../../contract/schemas/shared.ts';
import type { Result } from '../../shared/result.ts';
import type {
  ToolEventMessage,
  UpstreamTransportMessage,
} from '../../contract/schemas/upstream.ts';
import type { PlainObject, UnknownBoundaryInput } from '../../shared/boundary-types.ts';
import { readString } from '../../shared/type-guards.ts';
import { zodErrorToWireViolation } from '../zod/zod-error-to-wire-violation.ts';
import {
  heartbeatTransportSchema,
  registerTransportSchema,
  registerOkTransportSchema,
  registerRejectedTransportSchema,
  sessionCreatedTransportSchema,
  statusResponseTransportSchema,
  toolDoneTransportSchema,
  toolErrorTransportSchema,
  toolEventTransportSchema,
} from '../../contract/schemas/upstream.ts';
import { fail, isRecord, ok, unsupportedMessage } from './shared.ts';
import { DefaultToolEventValidator } from './tool-event-validator.ts';

const toolEventEnvelopeInputSchema = z.object({
  type: z.literal('tool_event'),
  toolSessionId: requiredTrimmedString,
  // 这里保留宽松输入类型：tool_event 外层只负责先校验 envelope，event 本体要交给独立 validator 收窄。
  event: z.unknown(),
});

function normalizeToolEventMessage(raw: PlainObject): Result<ToolEventMessage, WireContractViolation> {
  const parsed = toolEventEnvelopeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: zodErrorToWireViolation(parsed.error, {
        stage: 'transport',
        messageType: 'tool_event',
      }),
    };
  }

  const validator = new DefaultToolEventValidator();
  const eventResult = validator.validate(parsed.data.event);
  if (!eventResult.ok) {
    return eventResult;
  }

  const normalized = toolEventTransportSchema.safeParse({
    type: parsed.data.type,
    toolSessionId: parsed.data.toolSessionId,
    event: eventResult.value,
  });
  return normalized.success
    ? ok(normalized.data)
    : {
        ok: false,
        error: zodErrorToWireViolation(normalized.error, { stage: 'transport', messageType: 'tool_event' }),
      };
}

export class DefaultTransportMessageValidator implements TransportMessageValidatorPort {
  validate(raw: UnknownBoundaryInput): Result<UpstreamTransportMessage, WireContractViolation> {
    if (!isRecord(raw) || !readString(raw.type)) {
      return fail({
        stage: 'transport',
        code: 'missing_required_field',
        field: 'type',
        message: 'type is required',
      });
    }

    switch (raw.type) {
      case 'register': {
        const parsed = registerTransportSchema.safeParse(raw);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, error: zodErrorToWireViolation(parsed.error, { stage: 'transport', messageType: 'register' }) };
      }
      case 'register_ok': {
        const parsed = registerOkTransportSchema.safeParse(raw);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, error: zodErrorToWireViolation(parsed.error, { stage: 'transport', messageType: 'register_ok' }) };
      }
      case 'register_rejected': {
        const parsed = registerRejectedTransportSchema.safeParse(raw);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, error: zodErrorToWireViolation(parsed.error, { stage: 'transport', messageType: 'register_rejected' }) };
      }
      case 'heartbeat': {
        const parsed = heartbeatTransportSchema.safeParse(raw);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, error: zodErrorToWireViolation(parsed.error, { stage: 'transport', messageType: 'heartbeat' }) };
      }
      case 'tool_event':
        return normalizeToolEventMessage(raw);
      case 'tool_done': {
        const parsed = toolDoneTransportSchema.safeParse(raw);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, error: zodErrorToWireViolation(parsed.error, { stage: 'transport', messageType: 'tool_done' }) };
      }
      case 'tool_error': {
        const parsed = toolErrorTransportSchema.safeParse(raw);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, error: zodErrorToWireViolation(parsed.error, { stage: 'transport', messageType: 'tool_error' }) };
      }
      case 'session_created': {
        const parsed = sessionCreatedTransportSchema.safeParse(raw);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, error: zodErrorToWireViolation(parsed.error, { stage: 'transport', messageType: 'session_created' }) };
      }
      case 'status_response': {
        const parsed = statusResponseTransportSchema.safeParse(raw);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, error: zodErrorToWireViolation(parsed.error, { stage: 'transport', messageType: 'status_response' }) };
      }
      default:
        return unsupportedMessage(readString(raw.type) ?? String(raw.type), 'transport');
    }
  }
}
