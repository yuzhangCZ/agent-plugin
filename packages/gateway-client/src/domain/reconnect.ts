export const GATEWAY_RECONNECT_JITTER = {
  NONE: 'none',
  FULL: 'full',
} as const;

export type GatewayReconnectJitter = (typeof GATEWAY_RECONNECT_JITTER)[keyof typeof GATEWAY_RECONNECT_JITTER];

/**
 * 重连策略配置。
 * @remarks 该配置只描述重连窗口与退避行为，不承载具体调度实现。
 */
export interface GatewayReconnectConfig {
  baseMs: number;
  maxMs: number;
  exponential: boolean;
  jitter?: GatewayReconnectJitter;
  maxElapsedMs?: number;
  enabled?: boolean;
}
