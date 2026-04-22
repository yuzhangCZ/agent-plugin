export type GatewayClientErrorCode =
  | 'GATEWAY_CONNECT_ABORTED'
  | 'GATEWAY_CONNECT_TIMEOUT'
  | 'GATEWAY_WEBSOCKET_ERROR'
  | 'GATEWAY_CLOSED_BEFORE_OPEN'
  | 'GATEWAY_REGISTER_REJECTED'
  | 'GATEWAY_NOT_CONNECTED'
  | 'GATEWAY_NOT_READY'
  | 'GATEWAY_UNEXPECTED_CLOSE'
  | 'GATEWAY_PROTOCOL_VIOLATION';

export type GatewayClientErrorSource =
  | 'transport'
  | 'handshake'
  | 'inbound_protocol'
  | 'outbound_protocol'
  | 'state_gate';

export type GatewayClientErrorPhase =
  | 'before_open'
  | 'before_ready'
  | 'ready'
  | 'reconnecting'
  | 'stopping';

export type GatewayClientFailureClass =
  | 'handshake_failure'
  | 'transport_failure'
  | 'protocol_diagnostic'
  | 'state_gate';

/**
 * gateway-client 对外暴露的标准错误结构。
 */
export interface GatewayClientErrorShape {
  readonly code: GatewayClientErrorCode;
  readonly source: GatewayClientErrorSource;
  readonly phase: GatewayClientErrorPhase;
  readonly retryable: boolean;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * gateway-client 对外暴露的最小稳定中性失败信号。
 */
export interface GatewayClientFailureSignal {
  readonly failureClass: GatewayClientFailureClass;
  readonly code: GatewayClientErrorCode;
  readonly phase: GatewayClientErrorPhase;
  readonly retryable: boolean;
}

/**
 * 将错误事实层翻译为中性失败信号的统一入口。
 */
export interface GatewayClientFailureTranslator {
  translate(error: GatewayClientErrorShape): GatewayClientFailureSignal;
}
