/**
 * 发送日志上下文。
 * @remarks 用于在统一发送出口补齐链路字段，避免调用方在各层重复拼接日志维度。
 */
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
