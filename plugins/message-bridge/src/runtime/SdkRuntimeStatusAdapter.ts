import type {
  BridgeRuntimeErrorCode,
  BridgeRuntimeStatusSnapshot,
} from '@wecode/bridge-runtime-sdk';
import {
  getMessageBridgeStatus,
  publishMessageBridgeStatus,
  readMessageBridgeStatusSnapshot,
} from './MessageBridgeStatusStore.js';
import {
  createConnectingStatus,
  createReadyStatus,
  createUnavailableStatus,
  type MessageBridgeUnavailableReason,
} from './MessageBridgeStatus.js';

export interface SdkRuntimeStatusAdapter {
  publishConnecting(): void;
  publishDisabled(errorMessage: string): void;
  publishConfigInvalid(errorMessage: string): void;
  publishPluginFailure(errorMessage: string): void;
  publishRuntimeStatus(status: BridgeRuntimeStatusSnapshot): void;
}

function mapBridgeRuntimeErrorCodeToUnavailableReason(
  code: BridgeRuntimeErrorCode | undefined,
): MessageBridgeUnavailableReason {
  switch (code) {
    case 'gateway_connect_parameter_invalid':
      return 'config_invalid';
    case 'gateway_auth_rejected':
    case 'gateway_handshake_timeout':
    case 'gateway_handshake_rejected':
    case 'gateway_handshake_invalid':
      return 'server_failure';
    case 'gateway_transport_error':
    case 'gateway_reconnect_exhausted':
      return 'network_failure';
    case 'provider_unavailable':
    case 'runtime_internal_error':
      return 'plugin_failure';
    case 'gateway_unknown_error':
    case 'runtime_unknown_error':
    case 'probe_unknown_error':
    case undefined:
      return 'plugin_failure';
    default:
      return 'plugin_failure';
  }
}

function getRuntimeStatusErrorMessage(status: BridgeRuntimeStatusSnapshot): string {
  return status.error?.message ?? status.failureReason ?? 'unknown error';
}

export function createSdkRuntimeStatusAdapter(
  deps: {
    now?: () => number;
    publish?: typeof publishMessageBridgeStatus;
    read?: typeof getMessageBridgeStatus;
  } = {},
): SdkRuntimeStatusAdapter {
  const now = deps.now ?? Date.now;
  const publish = deps.publish ?? publishMessageBridgeStatus;
  const read = deps.read ?? readMessageBridgeStatusSnapshot;

  return {
    publishConnecting() {
      const current = read();
      publish(createConnectingStatus({
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      }));
    },

    publishDisabled(errorMessage: string) {
      const current = read();
      publish(createUnavailableStatus({
        reason: 'disabled',
        lastError: errorMessage,
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

    publishRuntimeStatus(status: BridgeRuntimeStatusSnapshot) {
      const current = read();
      if (status.state === 'ready') {
        publish(createReadyStatus({ updatedAt: now() }));
        return;
      }

      if (status.state === 'starting' || status.state === 'reconnecting') {
        publish(createConnectingStatus({
          updatedAt: now(),
          lastReadyAt: current.lastReadyAt,
        }));
        return;
      }
      if (status.state !== 'failed') {
        return;
      }

      const reason = mapBridgeRuntimeErrorCodeToUnavailableReason(status.error?.code);
      if (reason === 'network_failure' && current.phase === 'unavailable' && current.unavailableReason === 'server_failure') {
        return;
      }

      publish(createUnavailableStatus({
        reason,
        lastError: getRuntimeStatusErrorMessage(status),
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      }));
    },
  };
}
