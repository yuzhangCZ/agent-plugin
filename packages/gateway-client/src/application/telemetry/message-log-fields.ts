import type { GatewaySendContext } from '../../domain/send-context.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function buildPrimitivePreview(value: unknown): Record<string, unknown> {
  return { kind: Array.isArray(value) ? 'array' : typeof value };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function recordType(value: unknown): string {
  return typeof value === 'string' ? value : 'unknown';
}

/**
 * 提取消息类型字段，不存在时返回 `unknown`。
 */
export function getMessageType(message: unknown): string {
  return isRecord(message) ? recordType(message.type) : 'unknown';
}

/**
 * 提取网关 messageId 字段。
 */
export function extractGatewayMessageId(message: unknown): string | undefined {
  return isRecord(message) ? readString(message.messageId) : undefined;
}

/**
 * 提取 action 字段。
 */
export function extractMessageAction(message: unknown): string | undefined {
  return isRecord(message) ? readString(message.action) : undefined;
}

/**
 * 提取 welinkSessionId 字段。
 */
export function extractWelinkSessionId(message: unknown): string | undefined {
  return isRecord(message) ? readString(message.welinkSessionId) : undefined;
}

/**
 * 提取 toolSessionId 字段，兼容 payload 内嵌结构。
 */
export function extractToolSessionId(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const topLevel = readString(message.toolSessionId);
  if (topLevel) return topLevel;
  return isRecord(message.payload) ? readString(message.payload.toolSessionId) : undefined;
}

/**
 * 提取 event.type 字段。
 */
export function extractEventType(message: unknown): string | undefined {
  if (!isRecord(message) || !isRecord(message.event)) return undefined;
  return readString(message.event.type);
}

/**
 * 构建入站协议错误的裁剪预览，避免把整帧原文直接挂到错误详情或日志里。
 */
export function buildMessagePreview(message: unknown): Record<string, unknown> {
  if (!isRecord(message)) {
    return buildPrimitivePreview(message);
  }

  return {
    type: readString(message.type),
    keys: Object.keys(message).slice(0, 8),
  };
}

/**
 * 构建发送日志附加字段，并保留统一 payload 字节数。
 */
export function buildGatewaySendLogExtra(messageType: string, payloadBytes: number, logContext?: GatewaySendContext) {
  if (!logContext) {
    return { messageType, payloadBytes };
  }
  const { bridgeMessageId: _bridgeMessageId, ...rest } = logContext;
  return { messageType, payloadBytes, ...rest };
}
