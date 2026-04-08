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

export interface GatewayClientErrorShape {
  readonly code: GatewayClientErrorCode;
  readonly category: GatewayClientErrorCategory;
  readonly retryable: boolean;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}
