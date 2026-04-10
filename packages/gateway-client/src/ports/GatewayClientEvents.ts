import type { HeartbeatMessage } from '@agent-plugin/gateway-wire-v1';

import type { GatewayClientState } from '../domain/state.ts';
import type { GatewayClientErrorShape } from '../domain/error-contract.ts';
import type {
  GatewayBusinessMessage,
  GatewayInboundFrame,
  GatewayOutboundMessage,
} from './GatewayClientMessages.ts';

/**
 * GatewayClient 对外事件契约。
 */
export interface GatewayClientEvents {
  stateChange: (state: GatewayClientState) => void;
  message: (message: GatewayBusinessMessage) => void;
  inbound: (message: GatewayInboundFrame) => void;
  outbound: (message: GatewayOutboundMessage) => void;
  heartbeat: (message: HeartbeatMessage) => void;
  error: (error: GatewayClientErrorShape) => void;
}
