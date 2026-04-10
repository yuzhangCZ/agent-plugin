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
  GatewayConnection,
  DefaultGatewayConnection,
  GatewayConnectionOptions,
  GatewayConnectionEvents,
  GatewayClientError,
  type ConnectionState,
  type GatewaySendLogContext,
} from '@agent-plugin/gateway-client/legacy';

export { DefaultReconnectPolicy } from './ReconnectPolicy.js';
export type {
  ReconnectPolicy,
  ReconnectPolicyDependencies,
  ReconnectClock,
  ReconnectDecision,
  ReconnectExhaustedDecision,
  ReconnectScheduledDecision,
} from './ReconnectPolicy.js';
