import type { GatewayLogger } from '../../ports/LoggerPort.ts';
import type { GatewaySendContext } from '../../domain/send-context.ts';
import {
  buildGatewaySendLogExtra,
  extractEventType,
  extractGatewayMessageId,
  extractMessageAction,
  extractToolSessionId,
  extractWelinkSessionId,
  getMessageType,
} from './message-log-fields.ts';
import { formatRawPayload, safeStringify } from './payload-formatters.ts';
export { extractWebSocketErrorDetails, getErrorDetails, getErrorMessage } from './error-detail-mapper.ts';

const LARGE_PAYLOAD_WARN_THRESHOLD_BYTES = 1024 * 1024;
const RECENT_OUTBOUND_SUMMARY_LIMIT = 3;

interface MessageSummary {
  direction: 'sent' | 'received';
  messageType?: string;
  messageId?: string;
  payloadBytes?: number;
  eventType?: string;
  opencodeMessageId?: string;
}

interface OutboundMessageSummary {
  eventType?: string;
  toolSessionId?: string;
  opencodeMessageId?: string;
  payloadBytes: number;
}

function logDebug(logger: GatewayLogger | undefined, message: string, meta?: Record<string, unknown>): void {
  if (!logger) return;
  if (logger.debug) {
    logger.debug(message, meta);
    return;
  }
  logger.info?.(message, meta);
}

// GatewayClientTelemetry 统一封装日志与摘要采样，避免 runtime 主流程堆满观测细节。
export class GatewayClientTelemetry {
  private readonly logger?: GatewayLogger;
  private readonly debug: boolean;
  private lastMessageSummary: MessageSummary | null = null;
  private readonly recentOutboundSummaries: OutboundMessageSummary[] = [];

  constructor(options: { logger?: GatewayLogger; debug?: boolean }) {
    this.logger = options.logger;
    this.debug = !!options.debug;
  }

  reset(): void {
    this.lastMessageSummary = null;
    this.recentOutboundSummaries.length = 0;
  }

  logRawFrame(eventName: 'onOpen' | 'onMessage' | 'onError', payload: unknown): void {
    if (!this.debug || !this.logger) return;
    this.logger.info?.(`「${eventName}」===>「${formatRawPayload(payload)}」`);
  }

  markReceived(message: unknown, frameBytes: number): { messageType: string; gatewayMessageId?: string } {
    const messageType = getMessageType(message);
    const gatewayMessageId = extractGatewayMessageId(message);
    this.lastMessageSummary = {
      direction: 'received',
      messageType,
      messageId: gatewayMessageId,
      payloadBytes: frameBytes,
    };
    logDebug(this.logger, 'gateway.message.received', {
      messageType,
      frameBytes,
      gatewayMessageId,
      action: extractMessageAction(message),
      welinkSessionId: extractWelinkSessionId(message),
      toolSessionId: extractToolSessionId(message),
    });
    return { messageType, gatewayMessageId };
  }

  markSent(
    message: unknown,
    payloadBytes: number,
    logContext?: GatewaySendContext,
    recordOutbound = true,
  ): GatewaySendContext {
    const messageType = getMessageType(message);
    const effectiveLogContext: GatewaySendContext = {
      ...logContext,
      gatewayMessageId: logContext?.gatewayMessageId ?? extractGatewayMessageId(message),
      action: logContext?.action ?? extractMessageAction(message),
      welinkSessionId: logContext?.welinkSessionId ?? extractWelinkSessionId(message),
      toolSessionId: logContext?.toolSessionId ?? extractToolSessionId(message),
      eventType: logContext?.eventType ?? extractEventType(message),
    };
    this.lastMessageSummary = {
      direction: 'sent',
      messageType,
      messageId: effectiveLogContext.bridgeMessageId ?? effectiveLogContext.gatewayMessageId,
      payloadBytes,
      eventType: effectiveLogContext.eventType,
      opencodeMessageId: effectiveLogContext.opencodeMessageId,
    };
    if (recordOutbound) {
      this.recordOutboundSummary({
        eventType: effectiveLogContext.eventType,
        toolSessionId: effectiveLogContext.toolSessionId,
        opencodeMessageId: effectiveLogContext.opencodeMessageId,
        payloadBytes,
      });
    }
    if (recordOutbound && payloadBytes >= LARGE_PAYLOAD_WARN_THRESHOLD_BYTES) {
      this.logger?.warn?.('gateway.send.large_payload', {
        eventType: effectiveLogContext.eventType,
        toolSessionId: effectiveLogContext.toolSessionId,
        opencodeMessageId: effectiveLogContext.opencodeMessageId,
        payloadBytes,
      });
    }
    logDebug(this.logger, 'gateway.send', {
      ...buildGatewaySendLogExtra(messageType, payloadBytes, effectiveLogContext),
    });
    if (this.debug && this.logger) {
      this.logger.info?.(`「sendMessage」===>「${safeStringify(message)}」`);
    }
    return effectiveLogContext;
  }

  private recordOutboundSummary(summary: OutboundMessageSummary): void {
    this.recentOutboundSummaries.push(summary);
    if (this.recentOutboundSummaries.length > RECENT_OUTBOUND_SUMMARY_LIMIT) {
      this.recentOutboundSummaries.shift();
    }
  }

  logClose(meta: Record<string, unknown>): void {
    this.logger?.warn?.('gateway.close', {
      ...meta,
      lastMessageDirection: this.lastMessageSummary?.direction,
      lastMessageType: this.lastMessageSummary?.messageType,
      lastMessageId: this.lastMessageSummary?.messageId,
      lastPayloadBytes: this.lastMessageSummary?.payloadBytes,
      lastEventType: this.lastMessageSummary?.eventType,
      lastOpencodeMessageId: this.lastMessageSummary?.opencodeMessageId,
      recentOutboundMessages: this.recentOutboundSummaries.map((summary) => ({ ...summary })),
    });
  }

  logReconnectExhausted(elapsedMs: number, maxElapsedMs: number): void {
    this.logger?.warn?.('gateway.reconnect.exhausted', { elapsedMs, maxElapsedMs });
  }
}
