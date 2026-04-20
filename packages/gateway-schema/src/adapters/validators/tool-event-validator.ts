import type { ToolEventValidatorPort } from '../../application/ports/tool-event-validator-port.ts';
import { zodErrorToWireViolation } from '../zod/zod-error-to-wire-violation.ts';
import {
  messagePartDeltaEventSchema,
  messagePartRemovedEventSchema,
} from '../../contract/schemas/tool-event/opencode-provider-event/message-part.ts';
import { messagePartUpdatedEventSchema } from '../../contract/schemas/tool-event/opencode-provider-event/message-part-updated.ts';
import { messageUpdatedEventSchema } from '../../contract/schemas/tool-event/opencode-provider-event/message-updated.ts';
import {
  permissionAskedEventSchema,
  permissionUpdatedEventSchema,
} from '../../contract/schemas/tool-event/opencode-provider-event/permission.ts';
import { questionAskedEventSchema } from '../../contract/schemas/tool-event/opencode-provider-event/question.ts';
import {
  sessionErrorEventSchema,
  sessionIdleEventSchema,
  sessionStatusEventSchema,
  sessionUpdatedEventSchema,
} from '../../contract/schemas/tool-event/opencode-provider-event/session.ts';
import {
  MESSAGE_PART_STATE_STATUSES,
  MESSAGE_PART_TYPES,
  MESSAGE_ROLES,
  TOOL_EVENT_TYPES,
  type OpencodeToolEventType,
  type MessagePartStateStatus,
} from '../../contract/literals/tool-event.ts';
import type {
  GatewayToolEventPayload,
  MessagePartToolState,
  MessagePartUpdatedEvent,
  MessageUpdatedEvent,
} from '../../contract/schemas/tool-event/index.ts';
import { skillProviderEventSchema } from '../../contract/schemas/tool-event/skill-provider-event/index.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { JsonValue, PlainObject, UnknownBoundaryInput } from '../../shared/boundary-types.ts';
import { readArray, readEnumValue, readNumber, readPlainObject, readString, readTrimmedString } from '../../shared/type-guards.ts';
import { fail, invalidFieldType, isRecord, ok, requireNonEmptyString, unsupportedEventType } from './shared.ts';

type MessageUpdatedSummaryDiff = NonNullable<NonNullable<MessageUpdatedEvent['properties']['info']['summary']>['diffs']>[number];

function requirePlainObject(
  value: UnknownBoundaryInput,
  field: string,
  eventType: OpencodeToolEventType,
): Result<PlainObject, WireContractViolation> {
  const record = readPlainObject(value);
  if (!record) {
    return invalidFieldType({
      stage: 'event',
      field,
      expected: 'an object',
      eventType,
    });
  }

  return ok(record);
}

function readJsonValue(value: UnknownBoundaryInput): JsonValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  const arrayValue = readArray(value);
  if (arrayValue) {
    const normalizedItems = arrayValue.map((item) => readJsonValue(item));
    return normalizedItems.every((item) => item !== undefined) ? normalizedItems as JsonValue : undefined;
  }

  const objectValue = readPlainObject(value);
  if (!objectValue) {
    return undefined;
  }

  const normalizedEntries = Object.entries(objectValue).map(([key, entryValue]) => [key, readJsonValue(entryValue)] as const);
  if (normalizedEntries.some(([, entryValue]) => entryValue === undefined)) {
    return undefined;
  }

  return Object.fromEntries(normalizedEntries) as JsonValue;
}

function readOptionalModel(raw: UnknownBoundaryInput): MessageUpdatedEvent['properties']['info']['model'] | undefined {
  const model = readPlainObject(raw);
  if (!model) {
    return undefined;
  }

  const provider = readTrimmedString(model.provider);
  const name = readTrimmedString(model.name);
  const thinkLevel = readTrimmedString(model.thinkLevel);

  if (!provider && !name && !thinkLevel) {
    return undefined;
  }

  return {
    ...(provider ? { provider } : {}),
    ...(name ? { name } : {}),
    ...(thinkLevel ? { thinkLevel } : {}),
  };
}

function readSummaryDiff(raw: UnknownBoundaryInput): MessageUpdatedSummaryDiff | undefined {
  const diff = readPlainObject(raw);
  if (!diff) {
    return undefined;
  }

  const file = readTrimmedString(diff.file);
  const status = readTrimmedString(diff.status);
  const additions = readNumber(diff.additions);
  const deletions = readNumber(diff.deletions);

  if (!file && !status && additions === undefined && deletions === undefined) {
    return undefined;
  }

  return {
    ...(file ? { file } : {}),
    ...(status ? { status } : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
  };
}

function readSummary(raw: UnknownBoundaryInput): MessageUpdatedEvent['properties']['info']['summary'] | undefined {
  const summary = readPlainObject(raw);
  if (!summary) {
    return undefined;
  }

  const additions = readNumber(summary.additions);
  const deletions = readNumber(summary.deletions);
  const files = readNumber(summary.files);
  const rawDiffs = readArray(summary.diffs);
  const diffs = rawDiffs
    ?.map((item) => readSummaryDiff(item))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);

  if (additions === undefined && deletions === undefined && files === undefined && (!diffs || diffs.length === 0)) {
    return undefined;
  }

  return {
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(files !== undefined ? { files } : {}),
    ...(diffs && diffs.length > 0 ? { diffs } : {}),
  };
}

function parseSimpleEvent<T>(
  raw: PlainObject,
  eventType: OpencodeToolEventType,
  schema: { safeParse: (input: PlainObject) => { success: true; data: T } | { success: false; error: import('zod').ZodError } },
): Result<T, WireContractViolation> {
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : fail(
        zodErrorToWireViolation(parsed.error, {
          stage: 'event',
          messageType: eventType,
          eventType,
        }).violation,
      );
}

/**
 * 复杂事件先做白名单投影，再用 Zod 做最终准入。
 * 这样可以保留当前兼容裁剪语义，同时把最终外部形状固定在 adapter schema。
 */
function parseProjectedEvent<T>(
  projected: T,
  eventType: OpencodeToolEventType,
  schema: { safeParse: (input: T) => { success: true; data: T } | { success: false; error: import('zod').ZodError } },
): Result<T, WireContractViolation> {
  const parsed = schema.safeParse(projected);
  return parsed.success
    ? ok(parsed.data)
    : fail(
        zodErrorToWireViolation(parsed.error, {
          stage: 'event',
          messageType: eventType,
          eventType,
        }).violation,
      );
}

function projectMessageUpdatedEvent(raw: PlainObject): Result<MessageUpdatedEvent, WireContractViolation> {
  const eventType = TOOL_EVENT_TYPES[0];
  const properties = requirePlainObject(raw.properties, 'properties', eventType);
  if (!properties.ok) return properties;

  const info = requirePlainObject(properties.value.info, 'properties.info', eventType);
  if (!info.ok) return info;

  const id = requireNonEmptyString(info.value.id ?? properties.value.messageID, {
    stage: 'event',
    field: 'properties.info.id',
    eventType,
  });
  if (!id.ok) return id;

  const sessionID = requireNonEmptyString(info.value.sessionID ?? properties.value.sessionID, {
    stage: 'event',
    field: 'properties.info.sessionID',
    eventType,
  });
  if (!sessionID.ok) return sessionID;

  const role = readEnumValue(info.value.role, MESSAGE_ROLES);
  if (!role) {
    return invalidFieldType({
      stage: 'event',
      field: 'properties.info.role',
      expected: `"${MESSAGE_ROLES.join('" or "')}"`,
      eventType,
      code: 'invalid_field_value',
    });
  }

  const time = requirePlainObject(info.value.time, 'properties.info.time', eventType);
  if (!time.ok) return time;

  const created = readNumber(time.value.created);
  if (created === undefined) {
    return invalidFieldType({
      stage: 'event',
      field: 'properties.info.time.created',
      expected: 'a number',
      eventType,
    });
  }

  const updated = readNumber(time.value.updated);
  const model = readOptionalModel(info.value.model);
  const summary = readSummary(info.value.summary);
  const finish = readPlainObject(info.value.finish);
  const finishReason = finish ? readTrimmedString(finish.reason) : undefined;

  return ok({
    type: eventType,
    properties: {
      info: {
        id: id.value,
        sessionID: sessionID.value,
        role,
        time: {
          created,
          ...(updated !== undefined ? { updated } : {}),
        },
        ...(model ? { model } : {}),
        ...(summary ? { summary } : {}),
        ...(finishReason ? { finish: { reason: finishReason } } : {}),
      },
    },
  });
}

function readToolState(raw: UnknownBoundaryInput, eventType: OpencodeToolEventType): Result<MessagePartToolState | undefined, WireContractViolation> {
  const state = readPlainObject(raw);
  if (!state) {
    return ok(undefined);
  }

  const status = readEnumValue(state.status, MESSAGE_PART_STATE_STATUSES);
  if (!status) {
    return invalidFieldType({
      stage: 'event',
      field: 'properties.part.state.status',
      expected: `"${MESSAGE_PART_STATE_STATUSES.join('" or "')}"`,
      eventType,
      code: 'invalid_field_value',
    });
  }

  const output = readJsonValue(state.output);
  const error = readTrimmedString(state.error);
  const title = readTrimmedString(state.title);

  return ok({
    status: status as MessagePartStateStatus,
    ...(output !== undefined ? { output } : {}),
    ...(error ? { error } : {}),
    ...(title ? { title } : {}),
  });
}

function projectMessagePartUpdatedEvent(raw: PlainObject): Result<MessagePartUpdatedEvent, WireContractViolation> {
  const eventType = TOOL_EVENT_TYPES[1];
  const properties = requirePlainObject(raw.properties, 'properties', eventType);
  if (!properties.ok) return properties;

  const part = requirePlainObject(properties.value.part, 'properties.part', eventType);
  if (!part.ok) return part;

  const id = requireNonEmptyString(part.value.id, { stage: 'event', field: 'properties.part.id', eventType });
  if (!id.ok) return id;
  const sessionID = requireNonEmptyString(part.value.sessionID, { stage: 'event', field: 'properties.part.sessionID', eventType });
  if (!sessionID.ok) return sessionID;
  const messageID = requireNonEmptyString(part.value.messageID, { stage: 'event', field: 'properties.part.messageID', eventType });
  if (!messageID.ok) return messageID;

  const type = readEnumValue(part.value.type, MESSAGE_PART_TYPES);
  if (!type) {
    return invalidFieldType({
      stage: 'event',
      field: 'properties.part.type',
      expected: `"${MESSAGE_PART_TYPES.join('" or "')}"`,
      eventType,
      code: 'invalid_field_value',
    });
  }

  if (type === 'text' || type === 'reasoning') {
    const text = requireNonEmptyString(part.value.text, { stage: 'event', field: 'properties.part.text', eventType });
    if (!text.ok) return text;
    const rawDelta = properties.value.delta;
    const delta = rawDelta === undefined ? undefined : readTrimmedString(rawDelta);
    if (rawDelta !== undefined && !delta) {
      return invalidFieldType({
        stage: 'event',
        field: 'properties.delta',
        expected: 'a non-empty string',
        eventType,
      });
    }

    return ok({
      type: eventType,
      properties: {
        part: {
          id: id.value,
          sessionID: sessionID.value,
          messageID: messageID.value,
          type,
          text: text.value,
        },
        ...(delta ? { delta } : {}),
      },
    });
  }

  switch (type) {
    case 'tool': {
      const tool = requireNonEmptyString(part.value.tool, { stage: 'event', field: 'properties.part.tool', eventType });
      if (!tool.ok) return tool;
      const callID = requireNonEmptyString(part.value.callID, { stage: 'event', field: 'properties.part.callID', eventType });
      if (!callID.ok) return callID;
      const state = readToolState(part.value.state, eventType);
      if (!state.ok) return state;

      return ok({
        type: eventType,
        properties: {
          part: {
            id: id.value,
            sessionID: sessionID.value,
            messageID: messageID.value,
            type,
            tool: tool.value,
            callID: callID.value,
            ...(state.value ? { state: state.value } : {}),
          },
        },
      });
    }
    case 'step-start':
      return ok({
        type: eventType,
        properties: {
          part: {
            id: id.value,
            sessionID: sessionID.value,
            messageID: messageID.value,
            type,
          },
        },
      });
    case 'step-finish': {
      const tokens = readJsonValue(part.value.tokens);
      const cost = readNumber(part.value.cost);
      const reason = readTrimmedString(part.value.reason);
      return ok({
        type: eventType,
        properties: {
          part: {
            id: id.value,
            sessionID: sessionID.value,
            messageID: messageID.value,
            type,
            ...(tokens !== undefined ? { tokens } : {}),
            ...(cost !== undefined ? { cost } : {}),
            ...(reason ? { reason } : {}),
          },
        },
      });
    }
    case 'file': {
      const filename = readTrimmedString(part.value.filename);
      const url = readTrimmedString(part.value.url);
      const mime = readTrimmedString(part.value.mime);
      return ok({
        type: eventType,
        properties: {
          part: {
            id: id.value,
            sessionID: sessionID.value,
            messageID: messageID.value,
            type,
            ...(filename ? { filename } : {}),
            ...(url ? { url } : {}),
            ...(mime ? { mime } : {}),
          },
        },
      });
    }
    default:
      return invalidFieldType({
        stage: 'event',
        field: 'properties.part.type',
        expected: `"${MESSAGE_PART_TYPES.join('" or "')}"`,
        eventType,
        code: 'invalid_field_value',
      });
  }
}

function normalizeMessageUpdatedEvent(raw: PlainObject): Result<MessageUpdatedEvent, WireContractViolation> {
  const eventType = TOOL_EVENT_TYPES[0];
  const projected = projectMessageUpdatedEvent(raw);
  if (!projected.ok) {
    return projected;
  }

  return parseProjectedEvent(projected.value, eventType, messageUpdatedEventSchema);
}

function normalizeMessagePartUpdatedEvent(raw: PlainObject): Result<MessagePartUpdatedEvent, WireContractViolation> {
  const eventType = TOOL_EVENT_TYPES[1];
  const projected = projectMessagePartUpdatedEvent(raw);
  if (!projected.ok) {
    return projected;
  }

  return parseProjectedEvent(projected.value, eventType, messagePartUpdatedEventSchema);
}

function withFamily<Family extends GatewayToolEventPayload['family'], T extends object>(
  family: Family,
  event: T,
): T & { family: Family } {
  return {
    family,
    ...event,
  };
}

function parseSkillProviderEvent(raw: PlainObject): Result<GatewayToolEventPayload, WireContractViolation> {
  const parsed = skillProviderEventSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : fail(
        zodErrorToWireViolation(parsed.error, {
          stage: 'event',
          messageType: readString(raw.type) ?? 'tool_event',
          eventType: readString(raw.type) ?? 'tool_event',
        }).violation,
      );
}

function readRequiredToolEventFamily(raw: PlainObject): Result<'opencode' | 'skill', WireContractViolation> {
  const family = readTrimmedString(raw.family);
  if (!family) {
    return fail({
      stage: 'event',
      code: 'missing_required_field',
      field: 'family',
      message: 'family is required',
      messageType: readString(raw.type) ?? 'tool_event',
      eventType: readString(raw.type) ?? 'tool_event',
    });
  }

  if (family === 'opencode' || family === 'skill') {
    return ok(family);
  }

  return invalidFieldType({
    stage: 'event',
    field: 'family',
    expected: '"opencode" or "skill"',
    eventType: readString(raw.type) as OpencodeToolEventType | undefined,
    code: 'invalid_field_value',
  });
}

export class DefaultToolEventValidator implements ToolEventValidatorPort {
  validate(raw: UnknownBoundaryInput): Result<GatewayToolEventPayload, WireContractViolation> {
    if (!isRecord(raw) || !readString(raw.type)) {
      return fail({
        stage: 'event',
        code: 'missing_required_field',
        field: 'type',
        message: 'type is required',
      });
    }

    const family = readRequiredToolEventFamily(raw);
    if (!family.ok) {
      return family;
    }

    if (family.value === 'skill') {
      return parseSkillProviderEvent(raw);
    }

    switch (raw.type as OpencodeToolEventType) {
      case TOOL_EVENT_TYPES[0]: {
        const result = normalizeMessageUpdatedEvent(raw);
        return result.ok ? ok(withFamily('opencode', result.value)) : result;
      }
      case TOOL_EVENT_TYPES[1]: {
        const result = normalizeMessagePartUpdatedEvent(raw);
        return result.ok ? ok(withFamily('opencode', result.value)) : result;
      }
      case TOOL_EVENT_TYPES[2]: {
        const result = parseSimpleEvent(raw, TOOL_EVENT_TYPES[2], messagePartDeltaEventSchema);
        return result.ok ? ok(withFamily('opencode', result.value)) : result;
      }
      case TOOL_EVENT_TYPES[3]: {
        const result = parseSimpleEvent(raw, TOOL_EVENT_TYPES[3], messagePartRemovedEventSchema);
        return result.ok ? ok(withFamily('opencode', result.value)) : result;
      }
      case TOOL_EVENT_TYPES[4]: {
        const result = parseSimpleEvent(raw, TOOL_EVENT_TYPES[4], sessionStatusEventSchema);
        return result.ok ? ok(withFamily('opencode', result.value)) : result;
      }
      case TOOL_EVENT_TYPES[5]: {
        const result = parseSimpleEvent(raw, TOOL_EVENT_TYPES[5], sessionIdleEventSchema);
        return result.ok ? ok(withFamily('opencode', result.value)) : result;
      }
      case TOOL_EVENT_TYPES[6]: {
        const result = parseSimpleEvent(raw, TOOL_EVENT_TYPES[6], sessionUpdatedEventSchema);
        return result.ok ? ok(withFamily('opencode', result.value)) : result;
      }
      case TOOL_EVENT_TYPES[7]: {
        const result = parseSimpleEvent(raw, TOOL_EVENT_TYPES[7], sessionErrorEventSchema);
        return result.ok ? ok(withFamily('opencode', result.value)) : result;
      }
      case TOOL_EVENT_TYPES[8]: {
        const result = parseSimpleEvent(raw, TOOL_EVENT_TYPES[8], permissionUpdatedEventSchema);
        return result.ok ? ok(withFamily('opencode', result.value)) : result;
      }
      case TOOL_EVENT_TYPES[9]: {
        const result = parseSimpleEvent(raw, TOOL_EVENT_TYPES[9], permissionAskedEventSchema);
        return result.ok ? ok(withFamily('opencode', result.value)) : result;
      }
      case TOOL_EVENT_TYPES[10]: {
        const result = parseSimpleEvent(raw, TOOL_EVENT_TYPES[10], questionAskedEventSchema);
        return result.ok ? ok(withFamily('opencode', result.value)) : result;
      }
      default:
        return unsupportedEventType(readString(raw.type) ?? String(raw.type));
    }
  }
}
