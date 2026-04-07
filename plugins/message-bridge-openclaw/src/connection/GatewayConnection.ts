import { EventEmitter } from "node:events";
import type { BridgeLogger } from "../types.js";
import type { AkSkAuthPayload } from "./AkSkAuth.js";
import { UPSTREAM_MESSAGE_TYPE, validateUpstreamMessage, type HeartbeatMessage, type RegisterMessage } from "../contracts/transport.js";
import { asBoolean, asNumber, asRecord, asString } from "../utils/type-guards.js";

export type ConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "READY";

export interface GatewayConnectionEvents {
  stateChange: (state: ConnectionState) => void;
  message: (message: unknown) => void;
  inbound: (message: unknown) => void;
  outbound: (message: unknown) => void;
  heartbeat: (message: unknown) => void;
  error: (error: Error) => void;
}

export interface GatewayConnection {
  connect(): Promise<void>;
  disconnect(): void;
  send(message: unknown, logContext?: GatewaySendLogContext): void;
  getState(): ConnectionState;
  isConnected(): boolean;
  on<E extends keyof GatewayConnectionEvents>(event: E, listener: GatewayConnectionEvents[E]): this;
}

export interface GatewaySendLogContext {
  gatewayMessageId?: string;
  action?: string;
  welinkSessionId?: string;
  toolSessionId?: string;
  eventType?: string;
}

export interface GatewayConnectionOptions {
  url: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  reconnectExponential: boolean;
  heartbeatIntervalMs: number;
  debug?: boolean;
  authPayloadProvider?: () => AkSkAuthPayload;
  registerMessage: RegisterMessage;
  logger: BridgeLogger;
}

interface GatewayControlMessage {
  type: "register_ok" | "register_rejected";
  reason?: string;
}

const GATEWAY_REJECTION_CLOSE_CODES = new Set([4403, 4408, 4409]);

type GatewayCloseEventLike = Partial<CloseEvent> & {
  code?: unknown;
  reason?: unknown;
  wasClean?: unknown;
};

function logDebug(logger: BridgeLogger, message: string, meta?: Record<string, unknown>): void {
  if (logger.debug) {
    logger.debug(message, meta);
    return;
  }
  logger.info(message, meta);
}

function validateControlMessage(
  message: unknown,
  logger: BridgeLogger,
): RegisterMessage | HeartbeatMessage {
  const validation = validateUpstreamMessage(message);
  if (
    validation.ok &&
    (validation.value.type === UPSTREAM_MESSAGE_TYPE.REGISTER || validation.value.type === UPSTREAM_MESSAGE_TYPE.HEARTBEAT)
  ) {
    return validation.value;
  }

  const violation = validation.ok
    ? {
        stage: "transport",
        code: "unsupported_message",
        field: "type",
        message: `Unsupported control message type: ${String((message as { type?: unknown })?.type ?? "unknown")}`,
      }
    : validation.error.violation;

  logger.error("gateway.send.rejected_invalid_protocol", {
    messageType:
      message && typeof message === "object" && "type" in (message as { type?: unknown })
        ? String((message as { type?: unknown }).type ?? "unknown")
        : "unknown",
    stage: violation.stage,
    errorCode: violation.code,
    field: violation.field,
    errorMessage: violation.message,
  });
  throw new Error("gateway_invalid_transport_message");
}

function isGatewayControlMessage(value: unknown): value is GatewayControlMessage {
  const record = asRecord(value);
  return !!record && (record.type === "register_ok" || record.type === "register_rejected");
}

function isGatewayRejectedCloseCode(code: unknown): boolean {
  return typeof code === "number" && Number.isFinite(code) && GATEWAY_REJECTION_CLOSE_CODES.has(code);
}

function extractGatewayMessageId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return asString(record.messageId);
}

function extractMessageAction(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return asString(record.action);
}

function extractWelinkSessionId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return asString(record.welinkSessionId);
}

function extractToolSessionId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const toolSessionId = asString(record.toolSessionId);
  if (toolSessionId) {
    return toolSessionId;
  }
  const payload = asRecord(record.payload);
  if (!payload) {
    return undefined;
  }
  return asString(payload.toolSessionId);
}

function extractEventType(value: unknown): string | undefined {
  const record = asRecord(value);
  const event = asRecord(record?.event);
  if (!record || !event) {
    return undefined;
  }
  return asString(event.type);
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildAuthSubprotocol(payload: AkSkAuthPayload): string {
  return `auth.${encodeBase64Url(JSON.stringify(payload))}`;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, raw) => {
      if (typeof raw === "bigint") {
        return raw.toString();
      }
      if (raw instanceof Error) {
        return {
          name: raw.name,
          message: raw.message,
          stack: raw.stack,
        };
      }
      if (raw && typeof raw === "object") {
        if (seen.has(raw)) {
          return "[Circular]";
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
  if (typeof payload === "string") {
    return payload;
  }
  if (payload === null || payload === undefined) {
    return "";
  }
  if (typeof payload === "number" || typeof payload === "boolean" || typeof payload === "bigint") {
    return String(payload);
  }
  if (payload instanceof ArrayBuffer) {
    return `[binary ArrayBuffer byteLength=${payload.byteLength}]`;
  }
  if (ArrayBuffer.isView(payload)) {
    return `[binary ${payload.constructor.name} byteLength=${payload.byteLength}]`;
  }
  if (typeof Blob !== "undefined" && payload instanceof Blob) {
    return `[binary Blob size=${payload.size} type=${payload.type || "application/octet-stream"}]`;
  }
  const json = safeStringify(payload);
  return json === undefined ? String(payload) : json;
}

export class DefaultGatewayConnection extends EventEmitter implements GatewayConnection {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyDisconnected = false;
  private state: ConnectionState = "DISCONNECTED";
  private reconnectAttempts = 0;

  constructor(private readonly options: GatewayConnectionOptions) {
    super();
  }

  getState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === "CONNECTED" || this.state === "READY";
  }

  private logRawFrame(eventName: "onOpen" | "onMessage" | "onError", payload: unknown): void {
    if (!this.options.debug) {
      return;
    }
    this.options.logger.info(`「${eventName}」===>「${formatRawPayload(payload)}」`);
  }

  async connect(): Promise<void> {
    this.manuallyDisconnected = false;
    this.setState("CONNECTING");
    this.options.logger.info("gateway.connect.started", { url: this.options.url });

    return new Promise((resolve, reject) => {
      let settled = false;
      let opened = false;

      const finalizeResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const finalizeReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      const authPayload = this.options.authPayloadProvider?.();
      const protocols = authPayload ? [buildAuthSubprotocol(authPayload)] : undefined;
      let ws: WebSocket;
      try {
        ws = protocols ? new WebSocket(this.options.url, protocols) : new WebSocket(this.options.url);
      } catch (error) {
        this.setState("DISCONNECTED");
        finalizeReject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.ws = ws;

      ws.onopen = (event) => {
        opened = true;
        this.reconnectAttempts = 0;
        this.logRawFrame("onOpen", event);
        this.options.logger.info("gateway.open", { url: this.options.url });
        this.setState("CONNECTED");
        try {
          this.send(this.options.registerMessage);
          this.options.logger.info("gateway.register.sent");
          finalizeResolve();
        } catch (error) {
          this.options.logger.error("gateway.register.failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          this.stopHeartbeat();
          ws.onmessage = null;
          ws.onclose = null;
          ws.onerror = null;
          this.ws?.close();
          this.ws = null;
          this.setState("DISCONNECTED");
          finalizeReject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      ws.onmessage = async (event) => {
        const data = await this.decodeMessageData(event.data);
        if (data === null) {
          return;
        }
        this.logRawFrame("onMessage", data);

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          logDebug(this.options.logger, "gateway.message.ignored_non_json", {
            payloadLength: data.length,
            frameBytes: Buffer.byteLength(data, "utf8"),
          });
          return;
        }

        const parsedMessage = asRecord(parsed);
        logDebug(this.options.logger, "gateway.message.received", {
          messageType: asString(parsedMessage?.type),
          frameBytes: Buffer.byteLength(data, "utf8"),
          gatewayMessageId: extractGatewayMessageId(parsed),
          action: extractMessageAction(parsed),
          welinkSessionId: extractWelinkSessionId(parsed),
          toolSessionId: extractToolSessionId(parsed),
        });

        this.emit("inbound", parsed);

        if (isGatewayControlMessage(parsed)) {
          if (parsed.type === "register_ok") {
            this.options.logger.info("gateway.register.accepted");
            this.setState("READY");
            this.options.logger.info("gateway.ready");
            this.startHeartbeat();
            return;
          }

          const error = new Error(parsed.reason || "gateway_register_rejected");
          this.options.logger.error("gateway.register.rejected", { reason: parsed.reason });
          this.manuallyDisconnected = true;
          this.ws?.close();
          this.emit("error", error);
          return;
        }

        if (this.state !== "READY") {
          logDebug(this.options.logger, "gateway.message.received_not_ready", {
            messageType: asString(parsedMessage?.type),
            state: this.state,
          });
          return;
        }

        this.emit("message", parsed);
      };

      ws.onerror = (event) => {
        this.logRawFrame("onError", event);
        const error = new Error("gateway_websocket_error");
        this.options.logger.error("gateway.error");
        this.emit("error", error);
        if (this.state !== "DISCONNECTED") {
          this.setState("DISCONNECTED");
        }
        finalizeReject(error);
      };

      ws.onclose = (event) => {
        const close = event as GatewayCloseEventLike;
        const stateBeforeClose = this.state;
        const rejected = isGatewayRejectedCloseCode(close.code);
        const reconnectPlanned = opened && !this.manuallyDisconnected && !rejected;
        this.options.logger.warn("gateway.close", {
          code: asNumber(close.code),
          reason: asString(close.reason) ?? "",
          wasClean: asBoolean(close.wasClean),
          stateBeforeClose,
          manuallyDisconnected: this.manuallyDisconnected,
          reconnectPlanned,
          opened,
          rejected,
        });
        if (!opened) {
          finalizeReject(new Error("gateway_websocket_closed_before_open"));
        }
        this.stopHeartbeat();
        this.ws = null;
        this.setState("DISCONNECTED");
        if (rejected) {
          this.options.logger.warn("gateway.close.rejected", {
            code: asNumber(close.code),
            reason: asString(close.reason) ?? "",
            rejected: true,
          });
          return;
        }
        if (reconnectPlanned) {
          this.scheduleReconnect();
        }
      };
    });
  }

  disconnect(): void {
    this.manuallyDisconnected = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.setState("DISCONNECTED");
  }

  send(message: unknown, logContext?: GatewaySendLogContext): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway_not_connected");
    }
    const messageRecord = asRecord(message);
    const messageType = asString(messageRecord?.type);
    const isControlMessage =
      messageType === UPSTREAM_MESSAGE_TYPE.REGISTER || messageType === UPSTREAM_MESSAGE_TYPE.HEARTBEAT;
    if (this.state !== "READY" && !isControlMessage) {
      this.options.logger.warn("gateway.send.rejected_not_ready", {
        state: this.state,
        messageType: messageType ?? "unknown",
      });
      throw new Error("Gateway connection is not ready. Cannot send business message.");
    }
    const normalizedMessage = isControlMessage
      ? validateControlMessage(message, this.options.logger)
      : message;
    const serialized = JSON.stringify(normalizedMessage);
    if (this.options.debug) {
      this.options.logger.info(`「sendMessage」===>「${serialized}」`);
    }
    logDebug(this.options.logger, "gateway.send", {
      messageType,
      payloadBytes: Buffer.byteLength(serialized, "utf8"),
      gatewayMessageId: logContext?.gatewayMessageId ?? extractGatewayMessageId(message),
      action: logContext?.action ?? extractMessageAction(message),
      welinkSessionId: logContext?.welinkSessionId ?? extractWelinkSessionId(message),
      toolSessionId: logContext?.toolSessionId ?? extractToolSessionId(message),
      eventType: logContext?.eventType ?? extractEventType(message),
    });
    this.ws.send(serialized);
    this.emit("outbound", message);
    if (messageRecord && messageRecord.type === UPSTREAM_MESSAGE_TYPE.HEARTBEAT) {
      this.emit("heartbeat", message);
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.emit("stateChange", state);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const heartbeat: HeartbeatMessage = {
        type: UPSTREAM_MESSAGE_TYPE.HEARTBEAT,
        timestamp: new Date().toISOString(),
      };
      try {
        this.send(heartbeat);
      } catch (error) {
        this.options.logger.error("gateway.heartbeat.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.options.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const baseDelay = Math.max(1, this.options.reconnectBaseMs);
    const maxDelay = Math.max(1, this.options.reconnectMaxMs);
    const delay = this.options.reconnectExponential
      ? Math.min(
          baseDelay * (2 ** this.reconnectAttempts),
          maxDelay,
        )
      : Math.min(baseDelay, maxDelay);

    this.reconnectAttempts += 1;
    this.options.logger.info("gateway.reconnect.scheduled", {
      reconnectAttempts: this.reconnectAttempts,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manuallyDisconnected) {
        return;
      }
      this.options.logger.info("gateway.reconnect.attempt", {
        reconnectAttempts: this.reconnectAttempts,
      });
      this.connect().catch((error) => {
        this.options.logger.warn("gateway.reconnect.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!this.manuallyDisconnected) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  private async decodeMessageData(data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<string | null> {
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof Blob) {
      return await data.text();
    }
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString("utf8");
    }
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    }
    return null;
  }
}
