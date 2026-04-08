export const GATEWAY_RECONNECT_JITTER = {
  NONE: 'none',
  FULL: 'full',
} as const;

export type GatewayReconnectJitter = (typeof GATEWAY_RECONNECT_JITTER)[keyof typeof GATEWAY_RECONNECT_JITTER];

export interface GatewayReconnectConfig {
  baseMs: number;
  maxMs: number;
  exponential: boolean;
  jitter?: GatewayReconnectJitter;
  maxElapsedMs?: number;
  enabled?: boolean;
}
