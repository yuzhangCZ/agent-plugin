export type GatewayClientErrorCode =
  | 'GATEWAY_CONNECT_ABORTED'
  | 'GATEWAY_CONNECT_PARAMETER_INVALID'
  | 'GATEWAY_AUTH_REJECTED'
  | 'GATEWAY_HANDSHAKE_TIMEOUT'
  | 'GATEWAY_HANDSHAKE_REJECTED'
  | 'GATEWAY_HANDSHAKE_INVALID'
  | 'GATEWAY_TRANSPORT_ERROR'
  | 'GATEWAY_INBOUND_PROTOCOL_INVALID'
  | 'GATEWAY_OUTBOUND_PROTOCOL_INVALID'
  | 'GATEWAY_NOT_CONNECTED'
  | 'GATEWAY_NOT_READY'
;

export type GatewayConnectionDisposition =
  | 'startup_failure'
  | 'runtime_failure'
  | 'diagnostic'
  | 'cancelled';

export type GatewayConnectionStage =
  | 'pre_open'
  | 'handshake'
  | 'ready';

/**
 * 宿主侧可复用的 gateway 可用性语义。
 * @remarks 只表达 gateway 是否可被视为 unavailable，不承载产品态细节。
 */
export type GatewayClientAvailability =
  | 'transport_unavailable'
  | 'remote_unavailable'
  | null;

/**
 * gateway-client 错误的诊断上下文。
 * @remarks 只承载附加观测信息，不承载核心决策语义。
 */
export interface GatewayClientErrorDetails {
  readonly closeCode?: number;
  readonly closeReason?: string;
  readonly wasClean?: boolean;
  readonly messageType?: string;
  readonly gatewayMessageId?: string;
  readonly action?: string;
  readonly welinkSessionId?: string;
  readonly toolSessionId?: string;
  readonly messagePreview?: string;
  readonly [key: string]: unknown;
}

/**
 * gateway-client 对外暴露的标准错误结构。
 */
export interface GatewayClientErrorShape {
  readonly code: GatewayClientErrorCode;
  readonly disposition: GatewayConnectionDisposition;
  readonly stage: GatewayConnectionStage;
  readonly retryable: boolean;
  readonly message: string;
  readonly details?: GatewayClientErrorDetails;
  readonly cause?: unknown;
}
