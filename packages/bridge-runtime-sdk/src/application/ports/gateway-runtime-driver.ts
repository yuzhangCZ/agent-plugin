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
  probe(input: { timeoutMs: number; abortSignal?: AbortSignal }): Promise<BridgeGatewayProbeResult>;
  isReady(): boolean;
}
