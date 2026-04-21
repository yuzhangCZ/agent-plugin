import type { RegisterMessage } from '@agent-plugin/gateway-schema';

import type { GatewayReconnectConfig } from '../domain/reconnect.ts';
import type { AkSkAuthPayload } from './GatewayAuthProvider.ts';
import type { GatewayLogger } from './LoggerPort.ts';

/**
 * 创建 GatewayClient 所需的基础配置。
 */
export interface GatewayClientConfig {
  url: string;
  debug?: boolean;
  reconnect?: GatewayReconnectConfig;
  heartbeatIntervalMs?: number;
  handshakeTimeoutMs?: number;
  abortSignal?: AbortSignal;
  authPayloadProvider?: () => AkSkAuthPayload;
  registerMessage: RegisterMessage;
  logger?: GatewayLogger;
}
