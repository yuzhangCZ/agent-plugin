import type { BridgeEvent } from '../../runtime/types.js';
import { asNumber, asRecord, asString } from '../../utils/type-guards.js';
import {
  TOOL_EVENT_TYPE,
  type MessageUpdatedSummaryDiff,
  type MessageUpdatedSummary,
  type MessageUpdatedEvent,
} from '../../gateway-wire/tool-event.js';
import type { GatewayProjectedEvent } from './projection-types.js';

function projectSummaryDiff(diff: unknown): MessageUpdatedSummaryDiff | null {
  const record = asRecord(diff);
  if (!record) {
    return null;
  }

  const projected: MessageUpdatedSummaryDiff = {};
  const file = asString(record.file);
  const status = asString(record.status);
  const additions = asNumber(record.additions);
  const deletions = asNumber(record.deletions);

  if (file !== undefined) projected.file = file;
  if (status !== undefined) projected.status = status;
  if (additions !== undefined) projected.additions = additions;
  if (deletions !== undefined) projected.deletions = deletions;

  return Object.keys(projected).length > 0 ? projected : null;
}

function projectSummary(summary: Record<string, unknown>): MessageUpdatedSummary {
  const projected: MessageUpdatedSummary = {};

  const additions = asNumber(summary.additions);
  const deletions = asNumber(summary.deletions);
  const files = asNumber(summary.files);
  const diffs = Array.isArray(summary.diffs)
    ? summary.diffs
        .map((diff) => projectSummaryDiff(diff))
        .filter((diff): diff is MessageUpdatedSummaryDiff => diff !== null)
    : undefined;

  if (additions !== undefined) projected.additions = additions;
  if (deletions !== undefined) projected.deletions = deletions;
  if (files !== undefined) projected.files = files;
  if (diffs !== undefined) projected.diffs = diffs;

  return projected;
}

export function projectMessageUpdatedEvent(raw: BridgeEvent): GatewayProjectedEvent {
  const properties = asRecord(raw.properties);
  const info = properties ? asRecord(properties.info) : null;
  if (!info) {
    return raw as unknown as GatewayProjectedEvent;
  }

  const projectedInfo: {
    id?: string;
    sessionID?: string;
    role?: MessageUpdatedEvent['properties']['info']['role'];
    time?: MessageUpdatedEvent['properties']['info']['time'];
    model?: MessageUpdatedEvent['properties']['info']['model'];
    summary?: MessageUpdatedEvent['properties']['info']['summary'];
    finish?: MessageUpdatedEvent['properties']['info']['finish'];
    error?: MessageUpdatedEvent['properties']['info']['error'];
  } = {};
  const id = asString(info.id);
  const sessionID = asString(info.sessionID);
  const role = asString(info.role);
  const time = asRecord(info.time);
  const model = asRecord(info.model);
  const summary = asRecord(info.summary);
  const finish = asString(info.finish);
  const error = asRecord(info.error);

  if (id !== undefined) {
    projectedInfo.id = id;
  }
  if (sessionID !== undefined) {
    projectedInfo.sessionID = sessionID;
  }
  if (role === 'user' || role === 'assistant') {
    projectedInfo.role = role;
  }
  if (time !== null && typeof time.created === 'number') {
    projectedInfo.time = {
      created: time.created,
      ...(typeof time.completed === 'number' ? { completed: time.completed } : {}),
    };
  }
  if (model !== null) {
    const projectedModel = {
      providerID: asString(model.providerID),
      modelID: asString(model.modelID),
      provider: asString(model.provider),
      name: asString(model.name),
      thinkLevel: asString(model.thinkLevel),
    };
    if (
      projectedModel.providerID
      || projectedModel.modelID
      || projectedModel.provider
      || projectedModel.name
      || projectedModel.thinkLevel
    ) {
      projectedInfo.model = projectedModel;
    }
  }
  if (summary) {
    const projectedSummary = projectSummary(summary);
    if (Object.keys(projectedSummary).length > 0) {
      projectedInfo.summary = projectedSummary;
    }
  }
  if (finish !== undefined) {
    projectedInfo.finish = finish;
  }
  if (error !== null) {
    const name = asString(error.name);
    if (name !== undefined) {
      projectedInfo.error = {
        name,
        ...(asString(error.message) !== undefined ? { message: asString(error.message) } : {}),
        ...(asNumber(error.statusCode) !== undefined ? { statusCode: asNumber(error.statusCode) } : {}),
        ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
        ...(asString(error.providerID) !== undefined ? { providerID: asString(error.providerID) } : {}),
      };
    }
  }

  return {
      type: TOOL_EVENT_TYPE.MESSAGE_UPDATED,
      properties: {
      info: projectedInfo as MessageUpdatedEvent['properties']['info'],
      },
    } as GatewayProjectedEvent;
}
