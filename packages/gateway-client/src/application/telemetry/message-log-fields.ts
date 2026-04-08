import type { GatewaySendContext } from '../../domain/send-context.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function recordType(value: unknown): string {
  return typeof value === 'string' ? value : 'unknown';
}

export function getMessageType(message: unknown): string {
  return isRecord(message) ? recordType(message.type) : 'unknown';
}

export function extractGatewayMessageId(message: unknown): string | undefined {
  return isRecord(message) ? readString(message.messageId) : undefined;
}

export function extractMessageAction(message: unknown): string | undefined {
  return isRecord(message) ? readString(message.action) : undefined;
}

export function extractWelinkSessionId(message: unknown): string | undefined {
  return isRecord(message) ? readString(message.welinkSessionId) : undefined;
}

export function extractToolSessionId(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const topLevel = readString(message.toolSessionId);
  if (topLevel) return topLevel;
  return isRecord(message.payload) ? readString(message.payload.toolSessionId) : undefined;
}

export function extractEventType(message: unknown): string | undefined {
  if (!isRecord(message) || !isRecord(message.event)) return undefined;
  return readString(message.event.type);
}

export function buildGatewaySendLogExtra(messageType: string, payloadBytes: number, logContext?: GatewaySendContext) {
  if (!logContext) {
    return { messageType, payloadBytes };
  }
  const { bridgeMessageId: _bridgeMessageId, ...rest } = logContext;
  return { messageType, payloadBytes, ...rest };
}
