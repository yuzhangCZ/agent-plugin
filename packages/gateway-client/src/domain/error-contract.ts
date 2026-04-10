export type GatewayClientErrorCategory = 'transport' | 'state' | 'auth' | 'protocol';

export type GatewayClientErrorCode =
  | 'GATEWAY_CONNECT_ABORTED'
  | 'GATEWAY_WEBSOCKET_ERROR'
  | 'GATEWAY_CLOSED_BEFORE_OPEN'
  | 'GATEWAY_REGISTER_REJECTED'
  | 'GATEWAY_NOT_CONNECTED'
  | 'GATEWAY_NOT_READY'
  | 'GATEWAY_UNEXPECTED_CLOSE'
  | 'GATEWAY_PROTOCOL_VIOLATION';

/**
 * gateway-client 对外暴露的标准错误结构。
 */
export interface GatewayClientErrorShape {
  readonly code: GatewayClientErrorCode;
  readonly category: GatewayClientErrorCategory;
  readonly retryable: boolean;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}
