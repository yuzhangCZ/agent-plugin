import type { ConnectionState } from '../types/index.js';
import type { GatewayConnectionCloseDetail } from '../connection/GatewayConnection.js';
import {
  getMessageBridgeStatus,
  publishMessageBridgeStatus,
} from './MessageBridgeStatusStore.js';

export interface BridgeRuntimeStatusAdapter {
  publishConnecting(): void;
  publishDisabled(): void;
  publishConfigInvalid(errorMessage: string): void;
  publishStartupFailed(errorMessage: string): void;
  publishRegisterRejected(reason?: string): void;
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
      publish({
        connected: false,
        phase: 'connecting',
        unavailableReason: null,
        willReconnect: true,
        lastError: null,
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      });
    },

    publishDisabled() {
      const current = read();
      publish({
        connected: false,
        phase: 'unavailable',
        unavailableReason: 'disabled',
        willReconnect: false,
        lastError: null,
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      });
    },

    publishConfigInvalid(errorMessage: string) {
      const current = read();
      publish({
        connected: false,
        phase: 'unavailable',
        unavailableReason: 'config_invalid',
        willReconnect: false,
        lastError: errorMessage,
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      });
    },

    publishStartupFailed(errorMessage: string) {
      const current = read();
      publish({
        connected: false,
        phase: 'unavailable',
        unavailableReason: 'startup_failed',
        willReconnect: false,
        lastError: errorMessage,
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      });
    },

    publishRegisterRejected(reason?: string) {
      const current = read();
      publish({
        connected: false,
        phase: 'unavailable',
        unavailableReason: 'register_rejected',
        willReconnect: false,
        lastError: reason ?? 'register rejected',
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      });
    },

    publishConnectionState(state: ConnectionState) {
      const current = read();

      if (state === 'READY') {
        publish({
          connected: true,
          phase: 'ready',
          unavailableReason: null,
          willReconnect: null,
          lastError: null,
          updatedAt: now(),
          lastReadyAt: now(),
        });
        return;
      }

      if (state === 'CONNECTING' || state === 'CONNECTED') {
        publish({
          connected: false,
          phase: 'connecting',
          unavailableReason: null,
          willReconnect: true,
          lastError: null,
          updatedAt: now(),
          lastReadyAt: current.lastReadyAt,
        });
        return;
      }

      if (current.phase === 'unavailable' && current.unavailableReason === 'register_rejected') {
        return;
      }

      publish({
        connected: false,
        phase: 'unavailable',
        unavailableReason: 'disconnected',
        willReconnect: false,
        lastError: null,
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      });
    },

    publishConnectionClosed(detail: GatewayConnectionCloseDetail) {
      const current = read();

      if (detail.willReconnect) {
        publish({
          connected: false,
          phase: 'connecting',
          unavailableReason: null,
          willReconnect: true,
          lastError: null,
          updatedAt: now(),
          lastReadyAt: current.lastReadyAt,
        });
        return;
      }

      if (!detail.opened || detail.manuallyDisconnected || detail.aborted) {
        return;
      }

      if (current.phase === 'unavailable' && current.unavailableReason === 'register_rejected') {
        return;
      }

      publish({
        connected: false,
        phase: 'unavailable',
        unavailableReason: detail.rejected ? 'server_disconnected' : 'disconnected',
        willReconnect: false,
        lastError: detail.reason ?? null,
        updatedAt: now(),
        lastReadyAt: current.lastReadyAt,
      });
    },
  };
}
