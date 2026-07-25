import type { GatewayMode, LabEvent, LabGatewayDownstreamView } from '@agent-plugin/bridge-runtime-sdk-lab-shared';

import { asRecord } from './sanitize.ts';

export function buildGatewayDownstreamViews(events: LabEvent[], mode: GatewayMode): LabGatewayDownstreamView[] {
  return events
    .map((event) => toGatewayDownstreamView(event, mode))
    .filter((view): view is LabGatewayDownstreamView => Boolean(view))
    .reverse()
    .slice(0, 80);
}

function toGatewayDownstreamView(event: LabEvent, mode: GatewayMode): LabGatewayDownstreamView | null {
  if (event.type === 'mock_gateway.downstream') {
    const raw = asRecord(event.meta)?.raw;
    const rawRecord = asRecord(raw);
    const payload = asRecord(rawRecord?.payload);
    return {
      id: event.id,
      at: event.at,
      source: 'mock-gateway',
      phase: 'mock_sent',
      messageType: stringField(rawRecord, 'type'),
      action: stringField(rawRecord, 'action'),
      command: stringField(rawRecord, 'action'),
      toolSessionId: stringField(rawRecord, 'toolSessionId') ?? stringField(payload, 'toolSessionId'),
      welinkSessionId: stringField(rawRecord, 'welinkSessionId'),
      traceId: stringField(rawRecord, 'traceId'),
      raw,
    };
  }

  if (event.type === 'sdk.log.info' && event.message === 'runtime_sdk.downstream.received') {
    const meta = asRecord(event.meta);
    return {
      id: event.id,
      at: event.at,
      source: mode,
      phase: 'received',
      messageType: stringField(meta, 'messageType'),
      action: stringField(meta, 'action'),
      toolSessionId: stringField(meta, 'toolSessionId'),
      welinkSessionId: stringField(meta, 'welinkSessionId'),
    };
  }

  if (event.type === 'sdk.log.debug' && event.message === 'gateway.message.received') {
    const meta = asRecord(event.meta);
    return {
      id: event.id,
      at: event.at,
      source: mode,
      phase: 'received',
      messageType: stringField(meta, 'messageType'),
      action: stringField(meta, 'action'),
      toolSessionId: stringField(meta, 'toolSessionId'),
      welinkSessionId: stringField(meta, 'welinkSessionId'),
    };
  }

  if (event.type.startsWith('sdk.log.') && event.message.startsWith('runtime_sdk.downstream.')) {
    const meta = asRecord(event.meta);
    const phase = event.message.replace('runtime_sdk.downstream.', '');
    if (!isProcessedPhase(phase)) {
      return null;
    }
    return {
      id: event.id,
      at: event.at,
      source: mode,
      phase,
      messageType: stringField(meta, 'messageType'),
      command: stringField(meta, 'command'),
      toolSessionId: stringField(meta, 'toolSessionId'),
      welinkSessionId: stringField(meta, 'welinkSessionId'),
      error: stringField(meta, 'error'),
      code: stringField(meta, 'code'),
    };
  }

  return null;
}

function isProcessedPhase(value: string): value is LabGatewayDownstreamView['phase'] {
  return value === 'handled' || value === 'failed' || value === 'invalid_invoke_rejected';
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
