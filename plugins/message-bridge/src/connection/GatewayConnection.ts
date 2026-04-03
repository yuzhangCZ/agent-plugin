import { EventEmitter } from 'events';
import { ConnectionState, RECONNECT_JITTER, type ReconnectConfig } from '../types/index.js';
import {
  UPSTREAM_MESSAGE_TYPE,
  validateUpstreamMessage,
  type HeartbeatMessage,
  type RegisterMessage,
} from '../contracts/transport-messages.js';
import type { BridgeLogger } from '../runtime/AppLogger.js';
import type { AkSkAuthPayload } from './AkSkAuth.js';
import { getErrorDetailsForLog, getErrorMessage } from '../utils/error.js';
import { asRecord } from '../utils/type-guards.js';
import {
  DefaultReconnectPolicy,
  type ReconnectClock,
  type ReconnectPolicy,
} from './ReconnectPolicy.js';

export interface GatewayConnectionEvents {
  stateChange: (state: ConnectionState) => void;
  message: (message: unknown) => void;
  error: (error: Error) => void;
}

export interface GatewayConnection {
  connect(): Promise<void>;
  disconnect(): void;
  send(message: unknown, logContext?: GatewaySendLogContext): void;
  isConnected(): boolean;
  getState(): ConnectionState;
  on<E extends keyof GatewayConnectionEvents>(event: E, listener: GatewayConnectionEvents[E]): this;
}

export interface GatewaySendLogContext {
  traceId?: string;
  runtimeTraceId?: string;
  bridgeMessageId?: string;
  gatewayMessageId?: string;
  sessionId?: string;
  welinkSessionId?: string;
  toolSessionId?: string;
  source?: string;
  eventType?: string;
  action?: string;
  opencodeMessageId?: string;
  opencodePartId?: string;
  toolCallId?: string;
  originalPayloadBytes?: number;
  transportPayloadBytes?: number;
}

function buildGatewaySendLogExtra(messageType: string, payloadBytes: number, logContext?: GatewaySendLogContext) {
  if (!logContext) {
    return { messageType, payloadBytes };
  }

  const { bridgeMessageId: _bridgeMessageId, ...rest } = logContext;
  return {
    messageType,
    payloadBytes,
    ...rest,
  };
}

export interface GatewayConnectionOptions {
  url: string;
  debug?: boolean;
  reconnect?: ReconnectConfig;
  reconnectPolicy?: ReconnectPolicy;
  clock?: ReconnectClock;
  random?: () => number;
  heartbeatIntervalMs?: number;
  abortSignal?: AbortSignal;
  authPayloadProvider?: () => AkSkAuthPayload;
  registerMessage: RegisterMessage;
  logger?: BridgeLogger;
}

type WsMessageEvent = { data: string | ArrayBuffer | Blob | Uint8Array };
type GatewayControlMessage = RegisterOkMessage | RegisterRejectedMessage;
const GATEWAY_REJECTION_CLOSE_CODES = new Set([4403, 4408, 4409]);

interface RegisterOkMessage {
  type: 'register_ok';
}

interface RegisterRejectedMessage {
  type: 'register_rejected';
  reason?: string;
}

function validateControlMessage(
  message: unknown,
  logger?: BridgeLogger,
): RegisterMessage | HeartbeatMessage {
  const validation = validateUpstreamMessage(message);
  if (validation.ok && (
    validation.value.type === UPSTREAM_MESSAGE_TYPE.REGISTER ||
    validation.value.type === UPSTREAM_MESSAGE_TYPE.HEARTBEAT
  )) {
    return validation.value;
  }

  const violation = validation.ok
    ? {
        stage: 'transport',
        code: 'unsupported_message',
        field: 'type',
        message: `Unsupported control message type: ${String((message as { type?: unknown })?.type ?? 'unknown')}`,
      }
    : validation.error.violation;

  logger?.error('gateway.send.rejected_invalid_protocol', {
    messageType: message && typeof message === 'object' && 'type' in (message as { type?: unknown })
      ? String((message as { type?: unknown }).type ?? 'unknown')
      : 'unknown',
    stage: violation.stage,
    errorCode: violation.code,
    field: violation.field,
    errorMessage: violation.message,
  });
  throw new Error('gateway_invalid_transport_message');
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, raw) => {
      if (typeof raw === 'bigint') {
        return raw.toString();
      }
      if (raw instanceof Error) {
        return {
          name: raw.name,
          message: raw.message,
          stack: raw.stack,
        };
      }
      if (raw && typeof raw === 'object') {
        if (seen.has(raw)) {
          return '[Circular]';
        }
        seen.add(raw);
      }
      return raw;
    });
  } catch {
    return String(value);
  }
}

function formatRawPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload === null || payload === undefined) {
    return '';
  }
  if (typeof payload === 'number' || typeof payload === 'boolean' || typeof payload === 'bigint') {
    return String(payload);
  }
  if (payload instanceof ArrayBuffer) {
    return `[binary ArrayBuffer byteLength=${payload.byteLength}]`;
  }
  if (ArrayBuffer.isView(payload)) {
    return `[binary ${payload.constructor.name} byteLength=${payload.byteLength}]`;
  }
  if (typeof Blob !== 'undefined' && payload instanceof Blob) {
    return `[binary Blob size=${payload.size} type=${payload.type || 'application/octet-stream'}]`;
  }

  const json = safeStringify(payload);
  return json === undefined ? String(payload) : json;
}

function extractWebSocketErrorDetails(event: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const record = asRecord(event);

  if (!record) {
    return {
      ...getErrorDetailsForLog(event),
    };
  }

  const baseError =
    record.error !== undefined && record.error !== event
      ? getErrorDetailsForLog(record.error)
      : getErrorDetailsForLog(event);
  Object.assign(details, baseError);

  if (typeof record.type === 'string') {
    details.eventType = record.type;
  }

  if (!details.errorDetail && typeof record.message === 'string' && record.message.trim()) {
    details.errorDetail = record.message;
  }

  const target = asRecord(record.target);
  if (target && typeof target.readyState === 'number') {
    details.readyState = target.readyState;
  }

  return details;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildAuthSubprotocol(payload: AkSkAuthPayload): string {
  return `auth.${encodeBase64Url(JSON.stringify(payload))}`;
}

function isGatewayControlMessage(message: unknown): message is GatewayControlMessage {
  const record = asRecord(message);
  if (!record || typeof record.type !== 'string') {
    return false;
  }
  return record.type === 'register_ok' || record.type === 'register_rejected';
}

function isGatewayRejectedCloseCode(code: number | undefined): boolean {
  return typeof code === 'number' && GATEWAY_REJECTION_CLOSE_CODES.has(code);
}

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

const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  baseMs: 1000,
  maxMs: 30000,
  exponential: true,
  jitter: RECONNECT_JITTER.FULL,
  maxElapsedMs: 600000,
};

export class DefaultGatewayConnection extends EventEmitter implements GatewayConnection {
  private readonly reconnectPolicy: ReconnectPolicy;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyDisconnected = false;
  private state: ConnectionState = 'DISCONNECTED';
  private lastMessageSummary: MessageSummary | null = null;
  private readonly recentOutboundSummaries: OutboundMessageSummary[] = [];

  constructor(private readonly options: GatewayConnectionOptions) {
    super();
    this.reconnectPolicy = options.reconnectPolicy ?? new DefaultReconnectPolicy(
      options.reconnect ?? DEFAULT_RECONNECT_CONFIG,
      {
        clock: options.clock,
        random: options.random,
      },
    );
  }

  private logRawFrame(eventName: 'onOpen' | 'onMessage' | 'onError', payload: unknown): void {
    if (!this.options.debug || !this.options.logger) {
      return;
    }
    this.options.logger.info(`「${eventName}」===>「${formatRawPayload(payload)}」`);
  }

  async connect(): Promise<void> {
    this.options.logger?.info('gateway.connect.started', { url: this.options.url, state: this.state });
    if (this.options.abortSignal?.aborted) {
      this.manuallyDisconnected = true;
      this.setState('DISCONNECTED');
      this.options.logger?.warn('gateway.connect.aborted_precheck');
      throw new Error('gateway_connection_aborted');
    }

    this.lastMessageSummary = null;
    this.recentOutboundSummaries.length = 0;
    this.setState('CONNECTING');

    return new Promise((resolve, reject) => {
      let settled = false;
      let opened = false;

      const finalizeResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupAbortListener();
        resolve();
      };

      const finalizeReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupAbortListener();
        reject(error);
      };

      const abortHandler = () => {
        this.manuallyDisconnected = true;
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        this.teardownTimers();
        this.setState('DISCONNECTED');
        this.options.logger?.warn('gateway.connect.aborted');
        finalizeReject(new Error('gateway_connection_aborted'));
      };

      const cleanupAbortListener = () => {
        this.options.abortSignal?.removeEventListener('abort', abortHandler);
      };

      if (this.options.abortSignal) {
        this.options.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      try {
        const url = new URL(this.options.url);
        const authPayload = this.options.authPayloadProvider?.();
        const protocols = authPayload ? [buildAuthSubprotocol(authPayload)] : undefined;
        const ws = protocols ? new WebSocket(url.toString(), protocols) : new WebSocket(url.toString());
        this.ws = ws;
        this.manuallyDisconnected = false;

        ws.onopen = (event) => {
          opened = true;
          this.logRawFrame('onOpen', event);
          this.options.logger?.info('gateway.open');
          this.setState('CONNECTED');
          try {
            this.send(this.options.registerMessage);
            this.options.logger?.info('gateway.register.sent', {
              toolType: this.options.registerMessage.toolType,
              toolVersion: this.options.registerMessage.toolVersion,
            });
            finalizeResolve();
          } catch (error) {
            this.options.logger?.error('gateway.register.failed', {
              error: getErrorMessage(error),
              ...getErrorDetailsForLog(error),
            });
            this.teardownTimers();
            ws.onmessage = null;
            ws.onclose = null;
            ws.onerror = null;
            this.ws?.close();
            this.ws = null;
            this.setState('DISCONNECTED');
            finalizeReject(error instanceof Error ? error : new Error(getErrorMessage(error)));
          }
        };

        ws.onclose = (event?: CloseEvent) => {
          const rejected = isGatewayRejectedCloseCode(event?.code);
          this.options.logger?.warn('gateway.close', {
            opened,
            manuallyDisconnected: this.manuallyDisconnected,
            aborted: !!this.options.abortSignal?.aborted,
            rejected,
            code: event?.code,
            reason: event?.reason,
            wasClean: event?.wasClean,
            lastMessageDirection: this.lastMessageSummary?.direction,
            lastMessageType: this.lastMessageSummary?.messageType,
            lastMessageId: this.lastMessageSummary?.messageId,
            lastPayloadBytes: this.lastMessageSummary?.payloadBytes,
            lastEventType: this.lastMessageSummary?.eventType,
            lastOpencodeMessageId: this.lastMessageSummary?.opencodeMessageId,
            recentOutboundMessages: this.recentOutboundSummaries.map((summary) => ({ ...summary })),
          });
          if (!opened) {
            finalizeReject(new Error('gateway_websocket_closed_before_open'));
          }
          this.teardownTimers();
          this.setState('DISCONNECTED');

          if (rejected) {
            this.options.logger?.warn('gateway.close.rejected', {
              code: event?.code,
              reason: event?.reason,
              rejected: true,
            });
            return;
          }

          if (opened && !this.manuallyDisconnected && !this.options.abortSignal?.aborted) {
            this.attemptReconnect();
          }
        };

        ws.onerror = (event?: unknown) => {
          this.logRawFrame('onError', event);
          const error = new Error('gateway_websocket_error');
          const errorDetails = extractWebSocketErrorDetails(event);
          this.options.logger?.error('gateway.error', {
            error: error.message,
            state: this.state,
            ...errorDetails,
          });
          this.emit('error', error);
          if (this.state !== 'DISCONNECTED') {
            this.setState('DISCONNECTED');
          }
          finalizeReject(error);
        };

        ws.onmessage = (event: MessageEvent) => {
          this.handleMessage(event as unknown as WsMessageEvent).catch((error) => {
            this.emit('error', error instanceof Error ? error : new Error(getErrorMessage(error)));
          });
        };
      } catch (error) {
        this.options.logger?.error('gateway.connect.failed', {
          error: getErrorMessage(error),
          ...getErrorDetailsForLog(error),
        });
        finalizeReject(error instanceof Error ? error : new Error(getErrorMessage(error)));
      }
    });
  }

  disconnect(): void {
    this.options.logger?.info('gateway.disconnect.requested', { state: this.state });
    this.manuallyDisconnected = true;
    this.reconnectPolicy.reset();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.teardownTimers();
    this.setState('DISCONNECTED');
  }

  send(message: unknown, logContext?: GatewaySendLogContext): void {
    if (!this.isConnected() || !this.ws) {
      this.options.logger?.warn('gateway.send.rejected_not_connected', {
        state: this.state,
        messageType:
          message && typeof message === 'object' && 'type' in (message as { type?: unknown })
            ? String((message as { type?: unknown }).type ?? '')
            : 'unknown',
      });
      throw new Error('WebSocket is not connected. Cannot send message.');
    }

    const messageType =
      message && typeof message === 'object' && 'type' in (message as { type?: unknown })
        ? String((message as { type?: unknown }).type ?? '')
        : 'unknown';
    const isControlMessage =
      messageType === UPSTREAM_MESSAGE_TYPE.REGISTER || messageType === UPSTREAM_MESSAGE_TYPE.HEARTBEAT;

    if (this.state !== 'READY' && !isControlMessage) {
      this.options.logger?.warn('gateway.send.rejected_not_ready', {
        state: this.state,
        messageType,
      });
      throw new Error('Gateway connection is not ready. Cannot send business message.');
    }
    const normalizedMessage = isControlMessage
      ? validateControlMessage(message, this.options.logger)
      : message;
    const serialized = JSON.stringify(normalizedMessage);
    const payloadBytes = Buffer.byteLength(serialized, 'utf8');
    this.lastMessageSummary = {
      direction: 'sent',
      messageType,
      messageId: logContext?.bridgeMessageId ?? logContext?.gatewayMessageId,
      payloadBytes,
      eventType: logContext?.eventType,
      opencodeMessageId: logContext?.opencodeMessageId,
    };
    if (!isControlMessage) {
      this.recordOutboundSummary({
        eventType: logContext?.eventType,
        toolSessionId: logContext?.toolSessionId,
        opencodeMessageId: logContext?.opencodeMessageId,
        payloadBytes,
      });
    }
    if (!isControlMessage && payloadBytes >= LARGE_PAYLOAD_WARN_THRESHOLD_BYTES) {
      this.options.logger?.warn('gateway.send.large_payload', {
        eventType: logContext?.eventType,
        toolSessionId: logContext?.toolSessionId,
        opencodeMessageId: logContext?.opencodeMessageId,
        payloadBytes,
      });
    }
    this.options.logger?.debug('gateway.send', {
      ...buildGatewaySendLogExtra(messageType, payloadBytes, logContext),
    });
    if (this.options.debug && this.options.logger) {
      this.options.logger.info(`「sendMessage」===>「${serialized}」`);
    }
    this.ws.send(serialized);
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getState(): ConnectionState {
    return this.state;
  }

  private setupHeartbeat(): void {
    this.teardownTimers();

    const heartbeatIntervalMs = this.options.heartbeatIntervalMs ?? 30000;

    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected() || !this.ws) {
        return;
      }

      const heartbeat: HeartbeatMessage = {
        type: UPSTREAM_MESSAGE_TYPE.HEARTBEAT,
        timestamp: new Date().toISOString(),
      };
      try {
        this.send(heartbeat);
        this.options.logger?.debug('gateway.heartbeat.sent');
      } catch (error) {
        this.options.logger?.error('gateway.heartbeat.failed', {
          error: getErrorMessage(error),
          ...getErrorDetailsForLog(error),
        });
      }
    }, heartbeatIntervalMs);
  }

  private teardownTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private attemptReconnect(): void {
    if (this.options.abortSignal?.aborted) {
      return;
    }

    const reconnectDecision = this.reconnectPolicy.scheduleNextAttempt();
    if (!reconnectDecision.ok) {
      this.logReconnectExhausted(reconnectDecision.elapsedMs, reconnectDecision.maxElapsedMs);
      return;
    }

    this.options.logger?.warn('gateway.reconnect.scheduled', {
      attempt: reconnectDecision.attempt,
      delayMs: reconnectDecision.delayMs,
      elapsedMs: reconnectDecision.elapsedMs,
    });

    this.reconnectTimer = setTimeout(async () => {
      if (this.manuallyDisconnected || this.options.abortSignal?.aborted) {
        return;
      }

      const exhaustedDecision = this.reconnectPolicy.getExhaustedDecision();
      if (exhaustedDecision) {
        this.logReconnectExhausted(exhaustedDecision.elapsedMs, exhaustedDecision.maxElapsedMs);
        return;
      }

      try {
        this.options.logger?.info('gateway.reconnect.attempt', {
          attempt: reconnectDecision.attempt,
        });
        await this.connect();
      } catch (error) {
        this.options.logger?.warn('gateway.reconnect.failed', {
          attempt: reconnectDecision.attempt,
          error: getErrorMessage(error),
          ...getErrorDetailsForLog(error),
        });
        if (!this.manuallyDisconnected) {
          this.attemptReconnect();
        }
      }
    }, reconnectDecision.delayMs);
  }

  private async handleMessage(event: WsMessageEvent): Promise<void> {
    let text: string;

    if (typeof event.data === 'string') {
      text = event.data;
    } else if (event.data instanceof Uint8Array) {
      text = new TextDecoder().decode(event.data);
    } else if (event.data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(event.data));
    } else {
      text = await (event.data as Blob).text();
    }
    const frameBytes = Buffer.byteLength(text, 'utf8');
    this.logRawFrame('onMessage', text);

    try {
      const message = JSON.parse(text);
      const messageType =
        message && typeof message === 'object' && 'type' in (message as { type?: unknown })
          ? String((message as { type?: unknown }).type ?? '')
          : 'unknown';
      const gatewayMessageId = this.extractGatewayMessageId(message);
      this.lastMessageSummary = {
        direction: 'received',
        messageType,
        messageId: gatewayMessageId,
        payloadBytes: frameBytes,
      };
      this.options.logger?.debug('gateway.message.received', { messageType, frameBytes, gatewayMessageId });
      if (isGatewayControlMessage(message)) {
        this.handleControlMessage(message);
        return;
      }
      if (this.state !== 'READY') {
        this.options.logger?.warn('gateway.message.ignored_not_ready', {
          state: this.state,
          messageType,
          gatewayMessageId,
        });
        return;
      }
      this.emit('message', message);
    } catch {
      this.options.logger?.debug('gateway.message.ignored_non_json', {
        payloadLength: text.length,
        frameBytes,
      });
      // Ignore non-json messages from gateway.
    }
  }

  private extractGatewayMessageId(message: unknown): string | undefined {
    const record = asRecord(message);
    if (!record) {
      return undefined;
    }
    return typeof record.messageId === 'string' ? record.messageId : undefined;
  }

  private recordOutboundSummary(summary: OutboundMessageSummary): void {
    this.recentOutboundSummaries.push(summary);
    if (this.recentOutboundSummaries.length > RECENT_OUTBOUND_SUMMARY_LIMIT) {
      this.recentOutboundSummaries.shift();
    }
  }

  private logReconnectExhausted(elapsedMs: number, maxElapsedMs: number): void {
    this.options.logger?.warn('gateway.reconnect.exhausted', {
      elapsedMs,
      maxElapsedMs,
    });
  }

  private handleControlMessage(message: GatewayControlMessage): void {
    if (message.type === 'register_ok') {
      if (this.state === 'READY') {
        this.options.logger?.warn('gateway.register.duplicate_ok');
        return;
      }
      this.reconnectPolicy.reset();
      this.setState('READY');
      this.options.logger?.info('gateway.register.accepted');
      this.setupHeartbeat();
      this.options.logger?.info('gateway.ready');
      return;
    }

    const reason = typeof message.reason === 'string' ? message.reason : undefined;
    this.options.logger?.error('gateway.register.rejected', { reason });
    this.manuallyDisconnected = true;
    if (this.ws) {
      this.ws.close();
    }
  }

  private setState(next: ConnectionState): void {
    this.state = next;
    this.emit('stateChange', next);
  }
}
