export interface ConnectionManager {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export { DefaultStateManager } from './StateManager.js';
export type { StateManager } from './StateManager.js';

export {
  createGatewayClient,
  type GatewayClient,
  type GatewayClientConfig,
  type GatewayClientEvents,
  GatewayClientError,
  type GatewayClientState as ConnectionState,
  type GatewaySendContext as GatewaySendLogContext,
} from '@agent-plugin/gateway-client';
