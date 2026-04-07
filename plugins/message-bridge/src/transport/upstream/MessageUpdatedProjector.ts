import type { BridgeEvent } from '../../runtime/types.js';
import { asNumber, asRecord, asString } from '../../utils/type-guards.js';
import {
  TOOL_EVENT_TYPE,
  type GatewayMessageSummaryDiff,
  type GatewayMessageSummary,
  type GatewayMessageUpdatedEvent,
} from '../../gateway-wire/tool-event.js';
import type { GatewayProjectedEvent } from './projection-types.js';

function projectSummaryDiff(diff: unknown): GatewayMessageSummaryDiff | null {
  const record = asRecord(diff);
  if (!record) {
    return null;
  }

  const projected: GatewayMessageSummaryDiff = {};
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

function projectSummary(summary: Record<string, unknown>): GatewayMessageSummary {
  const projected: GatewayMessageSummary = {};

  const additions = asNumber(summary.additions);
  const deletions = asNumber(summary.deletions);
  const files = asNumber(summary.files);
  const diffs = Array.isArray(summary.diffs)
    ? summary.diffs
        .map((diff) => projectSummaryDiff(diff))
        .filter((diff): diff is GatewayMessageSummaryDiff => diff !== null)
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
    role?: GatewayMessageUpdatedEvent['properties']['info']['role'];
    time?: GatewayMessageUpdatedEvent['properties']['info']['time'];
    model?: GatewayMessageUpdatedEvent['properties']['info']['model'];
    summary?: GatewayMessageUpdatedEvent['properties']['info']['summary'];
    finish?: GatewayMessageUpdatedEvent['properties']['info']['finish'];
  } = {};
  const id = asString(info.id);
  const sessionID = asString(info.sessionID);
  const role = asString(info.role);
  const time = asRecord(info.time);
  const model = asRecord(info.model);
  const summary = asRecord(info.summary);
  const finish = asRecord(info.finish);

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
      ...(typeof time.updated === 'number' ? { updated: time.updated } : {}),
    };
  }
  if (model !== null) {
    const projectedModel = {
      provider: asString(model.provider),
      name: asString(model.name),
      thinkLevel: asString(model.thinkLevel),
    };
    if (projectedModel.provider || projectedModel.name || projectedModel.thinkLevel) {
      projectedInfo.model = projectedModel;
    }
  }
  if (summary) {
    const projectedSummary = projectSummary(summary);
    if (Object.keys(projectedSummary).length > 0) {
      projectedInfo.summary = projectedSummary;
    }
  }
  if (finish) {
    const reason = asString(finish.reason);
    if (reason !== undefined) {
      projectedInfo.finish = { reason };
    }
  }

  return {
    type: TOOL_EVENT_TYPE.MESSAGE_UPDATED,
    properties: {
      info: projectedInfo as GatewayMessageUpdatedEvent['properties']['info'],
    },
  } as GatewayProjectedEvent;
}
