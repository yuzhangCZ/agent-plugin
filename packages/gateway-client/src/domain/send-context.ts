export interface GatewaySendContext {
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
