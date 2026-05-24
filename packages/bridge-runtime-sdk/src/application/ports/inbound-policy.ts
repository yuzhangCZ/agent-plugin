import type { GatewayInboundFrame } from '@agent-plugin/gateway-client';

/**
 * gateway inbound fail-closed 处理端口。
 */
export interface InboundPolicy {
  handle(frame: GatewayInboundFrame, input: { isGatewayReady: boolean }): void;
}
