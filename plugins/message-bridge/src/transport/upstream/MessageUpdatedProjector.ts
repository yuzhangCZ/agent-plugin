import type { BridgeEvent } from '../../runtime/types.js';
import { asNumber, asRecord, asString } from '../../utils/type-guards.js';
import type { GatewayProjectedEvent } from './projection-types.js';

function projectSummaryDiff(diff: unknown): Record<string, unknown> | null {
  const record = asRecord(diff);
  if (!record) {
    return null;
  }

  const projected: Record<string, unknown> = {};
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

function projectSummary(summary: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};

  const additions = asNumber(summary.additions);
  const deletions = asNumber(summary.deletions);
  const files = asNumber(summary.files);
  const diffs = Array.isArray(summary.diffs)
    ? summary.diffs
        .map((diff) => projectSummaryDiff(diff))
        .filter((diff): diff is Record<string, unknown> => diff !== null)
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
    return raw;
  }

  const projectedInfo: Record<string, unknown> = {};
  const id = asString(info.id);
  const sessionID = asString(info.sessionID);
  const role = asString(info.role);
  const time = asRecord(info.time);
  const model = asRecord(info.model);
  const summary = asRecord(info.summary);

  if (id !== undefined) projectedInfo.id = id;
  if (sessionID !== undefined) projectedInfo.sessionID = sessionID;
  if (role !== undefined) projectedInfo.role = role;
  if (time !== null) projectedInfo.time = time;
  if (model !== null) projectedInfo.model = model;
  if (summary) projectedInfo.summary = projectSummary(summary);

  return {
    type: raw.type,
    properties: {
      info: projectedInfo,
    },
  };
}
