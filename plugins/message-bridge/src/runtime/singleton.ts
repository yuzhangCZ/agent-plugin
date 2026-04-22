import { randomUUID } from 'crypto';
import { BridgeRuntime } from './BridgeRuntime.js';
import type { BridgeEvent, PluginInput } from './types.js';
import { AppLogger } from './AppLogger.js';
import { buildClientShapeSummary } from './clientShapeSummary.js';
import { resetMessageBridgeStatus } from './MessageBridgeStatusStore.js';
import { getErrorDetailsForLog, getErrorMessage } from '../utils/error.js';

let runtime: BridgeRuntime | null = null;
let initializing: Promise<BridgeRuntime> | null = null;
let lifecycleAbortController: AbortController | null = null;
let generation = 0;
type RuntimeInitState = 'never' | 'initializing' | 'succeeded' | 'failed_latched';
let initState: RuntimeInitState = 'never';
let latchedInitError: Error | null = null;
let currentRuntimeTraceId: string | null = null;
let loadedPluginInput: PluginInput | null = null;
let explicitStopLocked = false;

function ensureCurrentRuntimeTraceId(): string {
  if (!currentRuntimeTraceId) {
    currentRuntimeTraceId = randomUUID();
  }
  return currentRuntimeTraceId;
}

function clearCurrentRuntimeTraceId(): void {
  currentRuntimeTraceId = null;
}

/**
 * 返回当前 runtime 生命周期 traceId，供插件边界在 runtime 尚未可用时复用同一日志链路。
 */
export function getCurrentRuntimeTraceId(): string | null {
  return currentRuntimeTraceId;
}

function normalizeRuntimeStartError(error: unknown): Error {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
    return error;
  }

  const normalized = new Error(getErrorMessage(error));
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) {
      (normalized as Error & { code?: string }).code = code;
    }
  }
  (normalized as Error & { cause?: unknown }).cause = error;
  return normalized;
}

function clearInitState(): void {
  runtime = null;
  initializing = null;
  lifecycleAbortController = null;
  initState = 'never';
  latchedInitError = null;
}

function stopRuntimeInternal(options: { lock: boolean }): void {
  generation += 1;

  if (initializing) {
    lifecycleAbortController?.abort();
    initializing = null;
  }

  if (runtime) {
    runtime.stop();
    runtime = null;
  }

  lifecycleAbortController = null;
  initState = 'never';
  latchedInitError = null;
  explicitStopLocked = options.lock;
  resetMessageBridgeStatus();
  clearCurrentRuntimeTraceId();
}

function beginRuntimeInitialization(input: PluginInput, mode: 'auto' | 'explicit'): Promise<BridgeRuntime> {
  if (!runtime && !initializing && initState === 'never') {
    ensureCurrentRuntimeTraceId();
  }
  const logger = new AppLogger(
    input.client,
    { component: 'singleton' },
    currentRuntimeTraceId ?? undefined,
  );
  const attemptMessage =
    mode === 'explicit'
      ? 'runtime.singleton.init_explicit_attempt_started'
      : 'runtime.singleton.init_first_attempt_started';

  logger.info(attemptMessage);
  logger.info('runtime.singleton.client_shape', buildClientShapeSummary(input.client));

  const candidate = new BridgeRuntime({
    workspacePath: input.worktree || input.directory,
    hostDirectory: input.worktree || input.directory,
    client: input.client,
    runtimeTraceId: ensureCurrentRuntimeTraceId(),
  });
  const token = ++generation;
  lifecycleAbortController = new AbortController();
  initState = 'initializing';

  initializing = candidate
    .start({ abortSignal: lifecycleAbortController.signal })
    .then(() => {
      if (token !== generation || lifecycleAbortController?.signal.aborted) {
        candidate.stop();
        logger.warn('runtime.singleton.initialization_cancelled');
        throw new Error('runtime_initialization_cancelled');
      }
      runtime = candidate;
      initState = 'succeeded';
      latchedInitError = null;
      explicitStopLocked = false;
      logger.info('runtime.singleton.initialized');
      return candidate;
    })
    .catch((error) => {
      const cancelled = token !== generation;
      runtime = null;
      if (cancelled) {
        initState = 'never';
        latchedInitError = null;
      } else {
        initState = 'failed_latched';
        latchedInitError = normalizeRuntimeStartError(error);
      }
      logger.error('runtime.singleton.initialization_failed', {
        error: getErrorMessage(error),
        ...getErrorDetailsForLog(error),
      });
      throw error;
    })
    .finally(() => {
      initializing = null;
    });

  return initializing;
}

export function cacheLoadedPluginInput(input: PluginInput): void {
  loadedPluginInput = input;
}

export async function getOrCreateRuntime(input: PluginInput): Promise<BridgeRuntime | null> {
  const logger = new AppLogger(
    input.client,
    { component: 'singleton' },
    currentRuntimeTraceId ?? undefined,
  );
  if (runtime) {
    explicitStopLocked = false;
    initState = 'succeeded';
    logger.debug('runtime.singleton.reuse_existing');
    return runtime;
  }

  if (initializing) {
    logger.debug('runtime.singleton.await_initializing');
    return initializing;
  }

  if (explicitStopLocked) {
    logger.info('runtime.singleton.init_blocked_after_explicit_stop');
    return null;
  }

  if (initState === 'failed_latched' || initState === 'succeeded') {
    logger.warn('runtime.singleton.init_blocked_after_first_attempt', {
      initState,
      latchedError: latchedInitError ? getErrorMessage(latchedInitError) : null,
    });
    return null;
  }

  return beginRuntimeInitialization(input, 'auto');
}

export function getRuntime(): BridgeRuntime | null {
  return runtime;
}

/**
 * 宿主事件进入 runtime 的唯一访问口。
 * runtime 不可用时静默忽略，避免插件入口耦合 singleton 内部状态。
 */
export async function dispatchEventToActiveRuntime(event: BridgeEvent): Promise<void> {
  if (!runtime) {
    return;
  }
  await runtime.handleEvent(event);
}

export async function startRuntimeFromLoadedInput(): Promise<void> {
  if (!loadedPluginInput) {
    throw new Error('message_bridge_runtime_not_loaded');
  }

  stopRuntimeInternal({ lock: false });
  clearInitState();
  ensureCurrentRuntimeTraceId();
  try {
    const candidate = await beginRuntimeInitialization(loadedPluginInput, 'explicit');
    runtime = candidate;
  } catch (error) {
    throw normalizeRuntimeStartError(error);
  }
}

export function stopRuntime(): void {
  stopRuntimeInternal({ lock: true });
}

export function __resetRuntimeForTests(): void {
  stopRuntimeInternal({ lock: false });
  loadedPluginInput = null;
  explicitStopLocked = false;
  clearInitState();
}
