import type { GatewayDownstreamBusinessRequest, GatewayUplinkBusinessMessage } from '@agent-plugin/gateway-schema';

import type {
  BridgeGatewayHostError,
  BridgeGatewayHostState,
  BridgeGatewayProbeResult,
} from '../../infrastructure/gateway/gateway-host.ts';

export interface GatewayRuntimeDriverHandlers {
  onGatewayStateChanged(state: BridgeGatewayHostState): void;
  onBusinessMessage(message: GatewayDownstreamBusinessRequest): void;
  onNonRetryableError(error: BridgeGatewayHostError): void;
}

/**
 * lifecycle 依赖的最小 gateway runtime driver 端口。
 */
export interface GatewayRuntimeDriver {
  attach(handlers: GatewayRuntimeDriverHandlers): void;
  connect(): Promise<void>;
  disconnect(): void;
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
