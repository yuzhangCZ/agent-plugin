export interface ConnectionManager {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export {
  DefaultAkSkAuth,
  type AkSkAuthPayload,
  type GatewayAuthProvider as AkSkAuth,
} from '@agent-plugin/gateway-client/internal-auth';

export { StateManager, DefaultStateManager } from './StateManager.js';

export {
  createGatewayClient,
  type GatewayClient,
  type GatewayClientConfig,
  type GatewayClientEvents,
  GatewayClientError,
  type GatewayClientState as ConnectionState,
  type GatewaySendContext as GatewaySendLogContext,
} from '@agent-plugin/gateway-client';

export type {
  GatewayClient as GatewayConnection,
  GatewayClientConfig as GatewayConnectionOptions,
  GatewayClientEvents as GatewayConnectionEvents,
} from '@agent-plugin/gateway-client';

export { DefaultReconnectPolicy } from './ReconnectPolicy.js';
export type {
  ReconnectPolicy,
  ReconnectPolicyDependencies,
  ReconnectClock,
  ReconnectDecision,
  ReconnectExhaustedDecision,
  ReconnectScheduledDecision,
} from './ReconnectPolicy.js';
