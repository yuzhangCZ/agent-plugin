import { randomUUID } from 'crypto';
import { BridgeRuntime } from './BridgeRuntime.js';
import type { PluginInput } from './types.js';
import { AppLogger } from './AppLogger.js';
import { buildClientShapeSummary } from './clientShapeSummary.js';
import { getErrorDetailsForLog, getErrorMessage } from '../utils/error.js';

let runtime: BridgeRuntime | null = null;
let initializing: Promise<BridgeRuntime> | null = null;
let lifecycleAbortController: AbortController | null = null;
let generation = 0;
type RuntimeInitState = 'never' | 'initializing' | 'succeeded' | 'failed_latched';
let initState: RuntimeInitState = 'never';
let latchedInitError: Error | null = null;
let currentRuntimeTraceId: string | null = null;

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

export async function getOrCreateRuntime(input: PluginInput): Promise<BridgeRuntime | null> {
  if (!runtime && !initializing && initState === 'never') {
    ensureCurrentRuntimeTraceId();
  }

  const logger = new AppLogger(
    input.client,
    { component: 'singleton' },
    currentRuntimeTraceId ?? undefined,
  );
  if (runtime) {
    logger.debug('runtime.singleton.reuse_existing');
    return runtime;
  }

  if (initializing) {
    logger.debug('runtime.singleton.await_initializing');
    return initializing;
  }

  if (initState === 'failed_latched' || initState === 'succeeded') {
    logger.warn('runtime.singleton.init_blocked_after_first_attempt', {
      initState,
      latchedError: latchedInitError ? getErrorMessage(latchedInitError) : null,
    });
    return null;
  }

  logger.info('runtime.singleton.init_first_attempt_started');
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
        latchedInitError = error instanceof Error ? error : new Error(getErrorMessage(error));
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

export function getRuntime(): BridgeRuntime | null {
  return runtime;
}

export function stopRuntime(): void {
  generation += 1;

  if (initializing) {
    lifecycleAbortController?.abort();
    initializing = null;
  }

  if (!runtime) {
    lifecycleAbortController = null;
    initState = 'never';
    latchedInitError = null;
    clearCurrentRuntimeTraceId();
    return;
  }

  runtime.stop();
  runtime = null;
  lifecycleAbortController = null;
  initState = 'never';
  latchedInitError = null;
  clearCurrentRuntimeTraceId();
}

export function __resetRuntimeForTests(): void {
  stopRuntime();
  initState = 'never';
  latchedInitError = null;
  clearCurrentRuntimeTraceId();
}
