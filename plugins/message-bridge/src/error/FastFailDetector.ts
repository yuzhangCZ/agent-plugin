import {
  GATEWAY_CLIENT_STATE,
  type GatewayClientState,
} from '@agent-plugin/gateway-client';
import type { ErrorCode } from '../types/index.js';

export class FastFailDetector {
  static readonly connectionCheckTimeoutMs = 100;

  checkState(connectionState: GatewayClientState): ErrorCode | null {
    switch (connectionState) {
      case GATEWAY_CLIENT_STATE.DISCONNECTED:
      case GATEWAY_CLIENT_STATE.CONNECTING:
        return 'GATEWAY_UNREACHABLE';
      case GATEWAY_CLIENT_STATE.CONNECTED:
        return 'AGENT_NOT_READY';
      case GATEWAY_CLIENT_STATE.READY:
        return null;
      default:
        return 'AGENT_NOT_READY';
    }
  }

  isGatewayReachable(state: GatewayClientState): boolean {
    return state === GATEWAY_CLIENT_STATE.READY || state === GATEWAY_CLIENT_STATE.CONNECTED;
  }
}
