import type { BridgeEvent } from './types.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function getMessageUpdatedInfo(raw: BridgeEvent): Record<string, unknown> | null {
  const properties = asRecord(raw.properties);
  if (!properties) {
    return null;
  }
  return asRecord(properties.info);
}

function projectSummaryDiff(diff: unknown): Record<string, unknown> | null {
  const record = asRecord(diff);
  if (!record) {
    return null;
  }

  return {
    file: asString(record.file),
    status: asString(record.status),
    additions: asNumber(record.additions),
    deletions: asNumber(record.deletions),
  };
}

function projectMessageUpdatedEvent(raw: BridgeEvent): BridgeEvent {
  const info = getMessageUpdatedInfo(raw);
  if (!info) {
    return raw;
  }

  const summary = asRecord(info.summary);
  const projectedSummary = summary
    ? {
        additions: asNumber(summary.additions),
        deletions: asNumber(summary.deletions),
        files: asNumber(summary.files),
        diffs: Array.isArray(summary.diffs)
          ? summary.diffs
              .map((diff) => projectSummaryDiff(diff))
              .filter((diff): diff is Record<string, unknown> => diff !== null)
          : undefined,
      }
    : undefined;

  return {
    type: raw.type,
    properties: {
      info: {
        id: asString(info.id),
        sessionID: asString(info.sessionID),
        role: asString(info.role),
        time: asRecord(info.time) ?? undefined,
        model: asRecord(info.model) ?? undefined,
        summary: projectedSummary,
      },
    },
  };
}

// Transport projection belongs to runtime because it narrows the bridge-to-gateway
// payload only. Upstream extraction still owns the raw OpenCode event shape.
export function buildTransportEvent(normalized: {
  common: { eventType: string };
  raw: BridgeEvent;
}): BridgeEvent {
  if (normalized.common.eventType !== 'message.updated') {
    return normalized.raw;
  }

  return projectMessageUpdatedEvent(normalized.raw);
}

