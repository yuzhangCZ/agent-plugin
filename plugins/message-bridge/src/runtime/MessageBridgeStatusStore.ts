import {
  assertValidMessageBridgeStatusSnapshot,
  cloneMessageBridgeStatusSnapshot,
  createDefaultMessageBridgeStatusSnapshot,
  isSameMessageBridgeStatusSemantics,
  type MessageBridgeStatusSnapshot,
} from './MessageBridgeStatus.js';

type MessageBridgeStatusListener = (snapshot: MessageBridgeStatusSnapshot) => void;

let snapshot = createDefaultMessageBridgeStatusSnapshot();
const listeners = new Set<MessageBridgeStatusListener>();

export function getMessageBridgeStatus(): MessageBridgeStatusSnapshot {
  return cloneMessageBridgeStatusSnapshot(snapshot);
}

export function publishMessageBridgeStatus(nextSnapshot: MessageBridgeStatusSnapshot): MessageBridgeStatusSnapshot {
  assertValidMessageBridgeStatusSnapshot(nextSnapshot);

  if (isSameMessageBridgeStatusSemantics(snapshot, nextSnapshot)) {
    return getMessageBridgeStatus();
  }

  snapshot = cloneMessageBridgeStatusSnapshot(nextSnapshot);
  const publishedSnapshot = getMessageBridgeStatus();
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
  return () => {
    listeners.delete(listener);
  };
}

export function resetMessageBridgeStatus(): MessageBridgeStatusSnapshot {
  snapshot = createDefaultMessageBridgeStatusSnapshot();
  return getMessageBridgeStatus();
}

export function __resetMessageBridgeStatusForTests(): MessageBridgeStatusSnapshot {
  listeners.clear();
  return resetMessageBridgeStatus();
}
