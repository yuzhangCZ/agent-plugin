import type { ConnectionState } from '../types/index.js';
import type { GatewayConnectionCloseDetail } from '../connection/GatewayConnection.js';
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
  publishServerFailure(errorMessage?: string): void;
  publishConnectFailure(errorMessage: string): void;
  publishConnectionState(state: ConnectionState): void;
  publishConnectionClosed(detail: GatewayConnectionCloseDetail): void;
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
      const updatedAt = now();
      publish(createConnectingStatus({ updatedAt, lastReadyAt: current.lastReadyAt }));
    },

    publishDisabled() {
      const current = read();
      const updatedAt = now();
      publish(createUnavailableStatus({
        reason: 'disabled',
        lastError: null,
        updatedAt,
        lastReadyAt: current.lastReadyAt,
      }));
    },

    publishConfigInvalid(errorMessage: string) {
      const current = read();
      const updatedAt = now();
      publish(createUnavailableStatus({
        reason: 'config_invalid',
        lastError: errorMessage,
        updatedAt,
        lastReadyAt: current.lastReadyAt,
      }));
    },

    publishPluginFailure(errorMessage: string) {
      const current = read();
      const updatedAt = now();
      publish(createUnavailableStatus({
        reason: 'plugin_failure',
        lastError: errorMessage,
        updatedAt,
        lastReadyAt: current.lastReadyAt,
      }));
    },

    publishServerFailure(errorMessage?: string) {
      const current = read();
      const updatedAt = now();
      publish(createUnavailableStatus({
        reason: 'server_failure',
        lastError: errorMessage ?? 'server failure',
        updatedAt,
        lastReadyAt: current.lastReadyAt,
      }));
    },

    publishConnectFailure(errorMessage: string) {
      const current = read();
      if (current.phase === 'unavailable' && current.unavailableReason === 'server_failure') {
        return;
      }

      const updatedAt = now();
      publish(createUnavailableStatus({
        reason: 'network_failure',
        lastError: errorMessage,
        updatedAt,
        lastReadyAt: current.lastReadyAt,
      }));
    },

    publishConnectionState(state: ConnectionState) {
      const current = read();

      if (state === 'READY') {
        const updatedAt = now();
        publish(createReadyStatus({ updatedAt }));
        return;
      }

      if (state === 'CONNECTING' || state === 'CONNECTED') {
        const updatedAt = now();
        publish(createConnectingStatus({ updatedAt, lastReadyAt: current.lastReadyAt }));
        return;
      }

      if (current.phase === 'unavailable' && current.unavailableReason === 'server_failure') {
        return;
      }

      const updatedAt = now();
      publish(createUnavailableStatus({
        reason: 'network_failure',
        lastError: null,
        updatedAt,
        lastReadyAt: current.lastReadyAt,
      }));
    },

    publishConnectionClosed(detail: GatewayConnectionCloseDetail) {
      const current = read();

      if (detail.willReconnect) {
        const updatedAt = now();
        publish(createConnectingStatus({ updatedAt, lastReadyAt: current.lastReadyAt }));
        return;
      }

      if (detail.manuallyDisconnected || detail.aborted) {
        return;
      }

      if (!detail.opened && !detail.rejected) {
        return;
      }

      if (current.phase === 'unavailable' && current.unavailableReason === 'server_failure') {
        return;
      }

      const updatedAt = now();
      publish(createUnavailableStatus({
        reason: detail.rejected ? 'server_failure' : 'network_failure',
        lastError: detail.reason ?? null,
        updatedAt,
        lastReadyAt: current.lastReadyAt,
      }));
    },
  };
}
