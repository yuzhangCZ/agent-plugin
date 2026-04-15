export type MessageBridgePhase = 'connecting' | 'ready' | 'unavailable';

export type MessageBridgeUnavailableReason =
  | 'not_ready'
  | 'disabled'
  | 'config_invalid'
  | 'plugin_failure'
  | 'server_failure'
  | 'network_failure';

export interface MessageBridgeStatusSnapshot {
  connected: boolean;
  phase: MessageBridgePhase;
  unavailableReason: MessageBridgeUnavailableReason | null;
  willReconnect: boolean | null;
  lastError: string | null;
  updatedAt: number;
  lastReadyAt: number | null;
}

interface ConnectingStatusInput {
  updatedAt: number;
  lastReadyAt: number | null;
}

interface ReadyStatusInput {
  updatedAt: number;
}

interface UnavailableStatusInput {
  reason: MessageBridgeUnavailableReason;
  lastError: string | null;
  updatedAt: number;
  lastReadyAt: number | null;
}

export function createDefaultMessageBridgeStatusSnapshot(now: () => number = Date.now): MessageBridgeStatusSnapshot {
  return {
    connected: false,
    phase: 'unavailable',
    unavailableReason: 'not_ready',
    willReconnect: false,
    lastError: null,
    updatedAt: now(),
    lastReadyAt: null,
  };
}

export function createConnectingStatus(input: ConnectingStatusInput): MessageBridgeStatusSnapshot {
  return {
    connected: false,
    phase: 'connecting',
    unavailableReason: null,
    willReconnect: true,
    lastError: null,
    updatedAt: input.updatedAt,
    lastReadyAt: input.lastReadyAt,
  };
}

export function createReadyStatus(input: ReadyStatusInput): MessageBridgeStatusSnapshot {
  return {
    connected: true,
    phase: 'ready',
    unavailableReason: null,
    willReconnect: null,
    lastError: null,
    updatedAt: input.updatedAt,
    lastReadyAt: input.updatedAt,
  };
}

export function createUnavailableStatus(input: UnavailableStatusInput): MessageBridgeStatusSnapshot {
  return {
    connected: false,
    phase: 'unavailable',
    unavailableReason: input.reason,
    willReconnect: false,
    lastError: input.lastError,
    updatedAt: input.updatedAt,
    lastReadyAt: input.lastReadyAt,
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
