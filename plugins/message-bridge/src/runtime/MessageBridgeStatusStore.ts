import {
  assertValidMessageBridgeStatusSnapshot,
  cloneMessageBridgeStatusSnapshot,
  createDefaultMessageBridgeStatusSnapshot,
  isSameMessageBridgeStatusSemantics,
  type MessageBridgeStatusSnapshot,
} from './MessageBridgeStatus.js';
import { AppLogger, type BridgeLogger } from './AppLogger.js';

type MessageBridgeStatusListener = (snapshot: MessageBridgeStatusSnapshot) => void;
interface MessageBridgeStatusLoggerOptions {
  runtimeTraceIdProvider?: () => string | null;
}

let snapshot = createDefaultMessageBridgeStatusSnapshot();
const listeners = new Set<MessageBridgeStatusListener>();
let logger: BridgeLogger | null = null;
let runtimeTraceIdProvider: (() => string | null) | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasAppLog(client: unknown): boolean {
  if (!isRecord(client)) {
    return false;
  }

  const app = client.app;
  return isRecord(app) && typeof app.log === 'function';
}

function cloneCurrentSnapshot(): MessageBridgeStatusSnapshot {
  return cloneMessageBridgeStatusSnapshot(snapshot);
}

function logStatusApi(message: string, extra?: Record<string, unknown>): void {
  const runtimeTraceId = runtimeTraceIdProvider?.() ?? null;
  const traceOverrides = {
    runtimeTraceId,
    traceId: runtimeTraceId,
  };
  logger?.info(message, {
    ...(extra ?? {}),
    ...traceOverrides,
  });
}

export function configureMessageBridgeStatusLogger(client: unknown, options: MessageBridgeStatusLoggerOptions = {}): void {
  runtimeTraceIdProvider = options.runtimeTraceIdProvider ?? runtimeTraceIdProvider;
  if (!hasAppLog(client)) {
    return;
  }

  logger = new AppLogger(client, { component: 'status_api' });
}

export function getMessageBridgeStatus(): MessageBridgeStatusSnapshot {
  const currentSnapshot = cloneCurrentSnapshot();
  logStatusApi('status_api.query', {
    phase: currentSnapshot.phase,
    connected: currentSnapshot.connected,
    unavailableReason: currentSnapshot.unavailableReason,
    willReconnect: currentSnapshot.willReconnect,
    lastReadyAt: currentSnapshot.lastReadyAt,
    updatedAt: currentSnapshot.updatedAt,
  });
  return currentSnapshot;
}

export function publishMessageBridgeStatus(nextSnapshot: MessageBridgeStatusSnapshot): MessageBridgeStatusSnapshot {
  assertValidMessageBridgeStatusSnapshot(nextSnapshot);

  if (isSameMessageBridgeStatusSemantics(snapshot, nextSnapshot)) {
    return cloneCurrentSnapshot();
  }

  const previousSnapshot = cloneCurrentSnapshot();
  snapshot = cloneMessageBridgeStatusSnapshot(nextSnapshot);
  const publishedSnapshot = cloneCurrentSnapshot();
  logStatusApi('status_api.changed', {
    fromPhase: previousSnapshot.phase,
    toPhase: publishedSnapshot.phase,
    fromConnected: previousSnapshot.connected,
    toConnected: publishedSnapshot.connected,
    fromUnavailableReason: previousSnapshot.unavailableReason,
    toUnavailableReason: publishedSnapshot.unavailableReason,
    fromWillReconnect: previousSnapshot.willReconnect,
    toWillReconnect: publishedSnapshot.willReconnect,
    lastError: publishedSnapshot.lastError,
  });
  for (const listener of listeners) {
    try {
      listener(publishedSnapshot);
    } catch {
      // Listener failures must not break status fan-out.
    }
  }
  return publishedSnapshot;
}

export function subscribeMessageBridgeStatus(listener: MessageBridgeStatusListener): () => void {
  listeners.add(listener);
  logStatusApi('status_api.subscribe', { listenerCount: listeners.size });
  return () => {
    if (!listeners.delete(listener)) {
      return;
    }
    logStatusApi('status_api.unsubscribe', { listenerCount: listeners.size });
  };
}

export function resetMessageBridgeStatus(): MessageBridgeStatusSnapshot {
  return publishMessageBridgeStatus(createDefaultMessageBridgeStatusSnapshot());
}

export function __resetMessageBridgeStatusForTests(): MessageBridgeStatusSnapshot {
  listeners.clear();
  logger = null;
  runtimeTraceIdProvider = null;
  snapshot = createDefaultMessageBridgeStatusSnapshot(() => 0);
  return resetMessageBridgeStatus();
}
