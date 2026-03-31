export type MessageBridgePhase = 'connecting' | 'ready' | 'unavailable';

export type MessageBridgeUnavailableReason =
  | 'uninitialized'
  | 'disabled'
  | 'config_invalid'
  | 'disconnected'
  | 'server_disconnected'
  | 'register_rejected'
  | 'startup_failed';

export interface MessageBridgeStatusSnapshot {
  connected: boolean;
  phase: MessageBridgePhase;
  unavailableReason: MessageBridgeUnavailableReason | null;
  willReconnect: boolean | null;
  lastError: string | null;
  updatedAt: number;
  lastReadyAt: number | null;
}

export function createDefaultMessageBridgeStatusSnapshot(now: () => number = Date.now): MessageBridgeStatusSnapshot {
  return {
    connected: false,
    phase: 'unavailable',
    unavailableReason: 'uninitialized',
    willReconnect: false,
    lastError: null,
    updatedAt: now(),
    lastReadyAt: null,
  };
}

export function cloneMessageBridgeStatusSnapshot(
  snapshot: MessageBridgeStatusSnapshot,
): MessageBridgeStatusSnapshot {
  return { ...snapshot };
}

export function assertValidMessageBridgeStatusSnapshot(snapshot: MessageBridgeStatusSnapshot): void {
  if (snapshot.phase === 'ready') {
    if (!snapshot.connected || snapshot.unavailableReason !== null || snapshot.willReconnect !== null) {
      throw new Error('message_bridge_status_invalid_snapshot');
    }
    return;
  }

  if (snapshot.phase === 'connecting') {
    if (snapshot.connected || snapshot.unavailableReason !== null || snapshot.willReconnect !== true) {
      throw new Error('message_bridge_status_invalid_snapshot');
    }
    return;
  }

  if (snapshot.connected || snapshot.unavailableReason === null || snapshot.willReconnect !== false) {
    throw new Error('message_bridge_status_invalid_snapshot');
  }
}

export function isSameMessageBridgeStatusSemantics(
  left: MessageBridgeStatusSnapshot,
  right: MessageBridgeStatusSnapshot,
): boolean {
  return (
    left.connected === right.connected &&
    left.phase === right.phase &&
    left.unavailableReason === right.unavailableReason &&
    left.willReconnect === right.willReconnect &&
    left.lastError === right.lastError &&
    left.lastReadyAt === right.lastReadyAt
  );
}
