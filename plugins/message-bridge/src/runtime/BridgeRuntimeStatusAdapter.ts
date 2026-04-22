import {
  translateGatewayClientFailure,
  type GatewayClientErrorShape,
  type GatewayClientFailureSignal,
  type GatewayClientState,
} from '@agent-plugin/gateway-client';
import {
  getMessageBridgeStatus,
  publishMessageBridgeStatus,
} from './MessageBridgeStatusStore.js';
import {
  createConnectingStatus,
  createReadyStatus,
  createUnavailableStatus,
} from './MessageBridgeStatus.js';

export interface BridgeRuntimeStatusAdapter {
  publishConnecting(): void;
  publishDisabled(): void;
  publishConfigInvalid(errorMessage: string): void;
  publishPluginFailure(errorMessage: string): void;
  publishGatewayState(state: GatewayClientState): void;
  publishGatewayError(error: GatewayClientErrorShape): void;
}

function mapFailureSignalToReason(signal: GatewayClientFailureSignal): 'server_failure' | 'network_failure' | null {
  switch (signal.failureClass) {
    case 'handshake_failure':
      return 'server_failure';
    case 'transport_failure':
      return 'network_failure';
    case 'protocol_diagnostic':
    case 'state_gate':
      return null;
  }
}

export function createBridgeRuntimeStatusAdapter(
  deps: {
    now?: () => number;
    publish?: typeof publishMessageBridgeStatus;
    read?: typeof getMessageBridgeStatus;
  } = {},
): BridgeRuntimeStatusAdapter {
  const now = deps.now ?? Date.now;
  const publish = deps.publish ?? publishMessageBridgeStatus;
  const read = deps.read ?? getMessageBridgeStatus;

  return {
    publishConnecting() {
      const current = read();
      publish(createConnectingStatus({
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      }));
    },

    publishDisabled() {
      const current = read();
      publish(createUnavailableStatus({
        reason: 'disabled',
        lastError: null,
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      }));
    },

    publishConfigInvalid(errorMessage: string) {
      const current = read();
      publish(createUnavailableStatus({
        reason: 'config_invalid',
        lastError: errorMessage,
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      }));
    },

    publishPluginFailure(errorMessage: string) {
      const current = read();
      publish(createUnavailableStatus({
        reason: 'plugin_failure',
        lastError: errorMessage,
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      }));
    },

    publishGatewayState(state: GatewayClientState) {
      const current = read();
      if (state === 'READY') {
        publish(createReadyStatus({ updatedAt: now() }));
        return;
      }

      if (state === 'CONNECTING' || state === 'CONNECTED') {
        publish(createConnectingStatus({
          updatedAt: now(),
          lastReadyAt: current.lastReadyAt,
        }));
      }
    },

    publishGatewayError(error: GatewayClientErrorShape) {
      const current = read();
      const failureSignal = translateGatewayClientFailure(error);
      const reason = mapFailureSignalToReason(failureSignal);
      if (!reason) {
        return;
      }
      if (reason === 'network_failure' && current.phase === 'unavailable' && current.unavailableReason === 'server_failure') {
        return;
      }

      publish(createUnavailableStatus({
        reason,
        lastError: error.message,
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      }));
    },
  };
}
