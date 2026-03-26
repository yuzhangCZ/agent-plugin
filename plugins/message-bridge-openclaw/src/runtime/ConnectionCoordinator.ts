import type { BridgeLogger, MessageBridgeRuntimePhase, MessageBridgeStatusSnapshot } from "../types.js";

export type MessageBridgeProbePhase = "idle" | "connecting";

export interface MessageBridgeConnectionCoord {
  runtimePhase: MessageBridgeRuntimePhase;
  runtimeStartedAt: number | null;
  probePhase: MessageBridgeProbePhase;
  probeStartedAt: number | null;
  probeAbortController: AbortController | null;
  runtimeSnapshot: MessageBridgeStatusSnapshot | null;
  logger: BridgeLogger | null;
}

const coordination = new Map<string, MessageBridgeConnectionCoord>();

function createDefaultState(): MessageBridgeConnectionCoord {
  return {
    runtimePhase: "idle",
    runtimeStartedAt: null,
    probePhase: "idle",
    probeStartedAt: null,
    probeAbortController: null,
    runtimeSnapshot: null,
    logger: null,
  };
}

function getMutableState(accountId: string): MessageBridgeConnectionCoord {
  let current = coordination.get(accountId);
  if (!current) {
    current = createDefaultState();
    coordination.set(accountId, current);
  }
  return current;
}

function maybeCleanup(accountId: string, state: MessageBridgeConnectionCoord): void {
  if (
    state.runtimePhase === "idle" &&
    state.probePhase === "idle" &&
    state.runtimeSnapshot === null &&
    state.logger === null
  ) {
    coordination.delete(accountId);
  }
}

export function getConnectionCoord(accountId: string): MessageBridgeConnectionCoord {
  return { ...getMutableState(accountId) };
}

export function getRuntimeSnapshot(accountId: string): MessageBridgeStatusSnapshot | undefined {
  return getMutableState(accountId).runtimeSnapshot ?? undefined;
}

export function getAccountLogger(accountId: string): BridgeLogger | undefined {
  return getMutableState(accountId).logger ?? undefined;
}

export function markRuntimePhase(
  accountId: string,
  phase: MessageBridgeRuntimePhase,
  now: () => number = Date.now,
): MessageBridgeConnectionCoord {
  const state = getMutableState(accountId);
  state.runtimePhase = phase;
  state.runtimeStartedAt = phase === "connecting" ? now() : state.runtimeStartedAt;
  if (phase === "idle") {
    state.runtimeStartedAt = null;
  }
  maybeCleanup(accountId, state);
  return { ...state };
}

export function beginProbeConnect(
  accountId: string,
  now: () => number = Date.now,
): { state: MessageBridgeConnectionCoord; abortController: AbortController } {
  const state = getMutableState(accountId);
  const abortController = new AbortController();
  state.probePhase = "connecting";
  state.probeStartedAt = now();
  state.probeAbortController = abortController;
  return {
    state: { ...state },
    abortController,
  };
}

export function finishProbeConnect(accountId: string, abortController?: AbortController | null): MessageBridgeConnectionCoord {
  const state = getMutableState(accountId);
  if (!abortController || state.probeAbortController === abortController) {
    state.probePhase = "idle";
    state.probeStartedAt = null;
    state.probeAbortController = null;
  }
  maybeCleanup(accountId, state);
  return { ...state };
}

export function cancelProbeForRuntimeStart(accountId: string): boolean {
  const state = getMutableState(accountId);
  if (state.probePhase !== "connecting" || !state.probeAbortController) {
    maybeCleanup(accountId, state);
    return false;
  }
  state.probeAbortController.abort(new Error("probe_cancelled_for_runtime_start"));
  return true;
}

export function updateRuntimeSnapshot(accountId: string, snapshot: MessageBridgeStatusSnapshot): MessageBridgeConnectionCoord {
  const state = getMutableState(accountId);
  state.runtimeSnapshot = { ...snapshot };
  maybeCleanup(accountId, state);
  return { ...state };
}

export function setAccountLogger(accountId: string, logger: BridgeLogger | null): MessageBridgeConnectionCoord {
  const state = getMutableState(accountId);
  state.logger = logger;
  maybeCleanup(accountId, state);
  return { ...state };
}

export function resetRuntimeCoord(accountId: string): MessageBridgeConnectionCoord {
  const state = getMutableState(accountId);
  state.runtimePhase = "idle";
  state.runtimeStartedAt = null;
  state.runtimeSnapshot = null;
  maybeCleanup(accountId, state);
  return { ...state };
}

export function __resetConnectionCoordinatorForTests(): void {
  coordination.clear();
}
