import type { GatewayUplinkBusinessMessage } from '@agent-plugin/gateway-schema';

/**
 * runtime 统一上行发送端口。
 */
export interface OutboundSink {
  send(message: GatewayUplinkBusinessMessage): void;
}
