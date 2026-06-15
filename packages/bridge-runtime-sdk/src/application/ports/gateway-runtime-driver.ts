import type { GatewayDownstreamBusinessRequest, GatewayUplinkBusinessMessage } from '@agent-plugin/gateway-schema';
import type { GatewayClientStatus } from '@agent-plugin/gateway-client';

import type {
  BridgeGatewayProbeResult,
  BridgeGatewayHostConnection,
} from '../../infrastructure/gateway/gateway-host.ts';

export interface GatewayRuntimeDriverHandlers {
  onGatewayStatusChanged(status: GatewayClientStatus): void;
  onBusinessMessage(message: GatewayDownstreamBusinessRequest): void;
}

/**
 * lifecycle 依赖的最小 gateway runtime driver 端口。
 */
export interface GatewayRuntimeDriver {
  attach(handlers: GatewayRuntimeDriverHandlers): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ReturnType<BridgeGatewayHostConnection['getStatus']>;
  send(message: GatewayUplinkBusinessMessage): void;
  isReady(): boolean;
}

/**
 * 临时 gateway probe 驱动端口。
 * @remarks probe 使用旁路连接，不参与 runtime 主连接 lifecycle。
 */
export interface GatewayProbeDriver {
  probe(input: { timeoutMs: number; abortSignal?: AbortSignal }): Promise<BridgeGatewayProbeResult>;
}
