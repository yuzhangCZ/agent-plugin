import type {
  ProviderFact,
  ProviderTerminalResult,
} from '@wecode/bridge-runtime-sdk';
import type { BridgeLogger } from '../AppLogger.js';
import { AsyncIterableQueue } from './AsyncIterableQueue.js';
import type {
  AssistantMessageLifecycleState,
  AssistantMessageStateStorePort,
  PartKind,
  PartKindStorePort,
  RawEventTranslation,
} from './OpenCodeProviderAdapter.types.js';

const FACT_DRAIN_QUIET_PERIOD_MS = 40;
const FACT_DRAIN_TIMEOUT_MS = 250;

type ActiveProviderRunHandleOptions = {
  anchorSessionId: string;
  runId: string;
  initialTrackingSessionId: string;
  logger: BridgeLogger;
  onCleanup: (input: {
    anchorSessionId: string;
    runId: string;
    trackingSessionIds: ReadonlySet<string>;
  }) => void;
  hostSessionId?: string;
};

type ForceAbortReason = 'abort_session' | 'prompt_terminal_aborted' | 'superseded_run';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

/**
 * `prompt()` terminal 到 `ProviderRun.result()` 的唯一映射器。
 */
class PromptTerminalResolver {
  private readonly deferred = createDeferred<ProviderTerminalResult>();
  private settled = false;

  constructor(private readonly onSettled: (result: ProviderTerminalResult) => void) {}

  result(): Promise<ProviderTerminalResult> {
    return this.deferred.promise;
  }

  settle(result: ProviderTerminalResult): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.deferred.resolve(result);
    this.onSettled(result);
  }
}

/**
 * provider run 联合收口器。
 * @remarks
 * 插件必须自行保证：只有当 prompt terminal 已确定且 facts 已关闭时，
 * `ProviderRun.result()` 才能对外 resolve，不能把联合完成语义泄漏给 runtime。
 */
class RunCompletionResolver {
  private readonly deferred = createDeferred<ProviderTerminalResult>();
  private settled = false;

  result(): Promise<ProviderTerminalResult> {
    return this.deferred.promise;
  }

  settle(result: ProviderTerminalResult): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.deferred.resolve(result);
  }
}

/**
 * run 内 fact drain 收口器。
 * @remarks
 * 它只关心 raw event 已被解释后的“相关事件到达”和 `facts` 何时 close，
 * 不负责 terminal outcome 映射。
 */
class FactDrainTracker {
  private promptSettled = false;
  private closed = false;
  private lastRelevantEventAt = 0;
  private lastTerminalCandidateMessageId?: string;
  private quietTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      anchorSessionId: string;
      runId: string;
      queue: AsyncIterableQueue<ProviderFact>;
      logger: BridgeLogger;
      onClosed: () => void;
      quietPeriodMs?: number;
      drainTimeoutMs?: number;
    },
  ) {}

  noteRelevantEvent(terminalCandidateMessageId?: string): void {
    if (this.closed) {
      return;
    }

    this.lastRelevantEventAt = Date.now();
    if (terminalCandidateMessageId) {
      this.lastTerminalCandidateMessageId = terminalCandidateMessageId;
    }

    if (!this.promptSettled || !this.lastTerminalCandidateMessageId) {
      return;
    }

    this.armQuietTimer();
  }

  onPromptSettled(): void {
    if (this.closed || this.promptSettled) {
      return;
    }

    this.promptSettled = true;
    if (this.lastTerminalCandidateMessageId) {
      this.armQuietTimer();
    }
    this.armDrainTimer();
  }

  closeFacts(reason: 'quiet_period' | 'drain_timeout'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.options.logger.debug?.('provider_adapter.fact_drain.closed', {
      toolSessionId: this.options.anchorSessionId,
      runId: this.options.runId,
      reason,
      lastTerminalCandidateMessageId: this.lastTerminalCandidateMessageId,
    });
    this.options.queue.close();
    this.options.onClosed();
  }

  private armQuietTimer(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
    }
    const quietPeriodMs = this.options.quietPeriodMs ?? FACT_DRAIN_QUIET_PERIOD_MS;
    const elapsedMs = Math.max(0, Date.now() - this.lastRelevantEventAt);
    const delayMs = Math.max(0, quietPeriodMs - elapsedMs);
    this.quietTimer = setTimeout(() => {
      if (!this.promptSettled || !this.lastTerminalCandidateMessageId) {
        return;
      }
      this.closeFacts('quiet_period');
    }, delayMs);
  }

  private armDrainTimer(): void {
    if (this.drainTimer) {
      return;
    }
    this.drainTimer = setTimeout(() => {
      if (this.lastTerminalCandidateMessageId) {
        this.options.logger.warn('provider_adapter.protocol_diagnostic', {
          toolSessionId: this.options.anchorSessionId,
          runId: this.options.runId,
          code: 'facts_drain_timeout_after_terminal_candidate',
          lastTerminalCandidateMessageId: this.lastTerminalCandidateMessageId,
        });
      } else {
        this.options.logger.warn('provider_adapter.protocol_diagnostic', {
          toolSessionId: this.options.anchorSessionId,
          runId: this.options.runId,
          code: 'facts_drain_timeout_without_terminal_candidate',
        });
      }
      this.closeFacts('drain_timeout');
    }, this.options.drainTimeoutMs ?? FACT_DRAIN_TIMEOUT_MS);
  }
}

export class AssistantMessageStateStore implements AssistantMessageStateStorePort {
  private readonly sessions = new Map<string, Map<string, AssistantMessageLifecycleState>>();

  ensure(trackingSessionId: string, messageId: string): AssistantMessageLifecycleState {
    let sessionState = this.sessions.get(trackingSessionId);
    if (!sessionState) {
      sessionState = new Map();
      this.sessions.set(trackingSessionId, sessionState);
    }

    let messageState = sessionState.get(messageId);
    if (!messageState) {
      messageState = {
        startEmitted: false,
        doneEmitted: false,
      };
      sessionState.set(messageId, messageState);
    }
    return messageState;
  }

  isOpen(trackingSessionId: string, messageId: string): boolean {
    const state = this.sessions.get(trackingSessionId)?.get(messageId);
    return Boolean(state?.startEmitted) && !Boolean(state?.doneEmitted);
  }

  clearSession(trackingSessionId: string): void {
    this.sessions.delete(trackingSessionId);
  }

  has(trackingSessionId: string): boolean {
    return this.sessions.has(trackingSessionId);
  }
}

export class PartKindStore implements PartKindStorePort {
  private readonly sessions = new Map<string, Map<string, PartKind>>();

  remember(trackingSessionId: string, partId: string, kind: PartKind): void {
    let parts = this.sessions.get(trackingSessionId);
    if (!parts) {
      parts = new Map();
      this.sessions.set(trackingSessionId, parts);
    }
    parts.set(partId, kind);
  }

  resolve(trackingSessionId: string, partId: string): PartKind {
    return this.sessions.get(trackingSessionId)?.get(partId) ?? 'text';
  }

  clearSession(trackingSessionId: string): void {
    this.sessions.delete(trackingSessionId);
  }

  has(trackingSessionId: string): boolean {
    return this.sessions.has(trackingSessionId);
  }
}

export class ActiveProviderRunHandle {
  readonly queue = new AsyncIterableQueue<ProviderFact>();
  private readonly trackingSessionIds = new Set<string>();
  private readonly promptTerminalResolver: PromptTerminalResolver;
  private readonly completionResolver = new RunCompletionResolver();
  private readonly factDrainTracker: FactDrainTracker;
  private promptSettled = false;
  private factsClosed = false;
  private forceClosed = false;
  private cleanedUp = false;
  private terminalResult?: ProviderTerminalResult;

  readonly anchorSessionId: string;
  readonly runId: string;
  readonly hostSessionId: string;
  private readonly onCleanup: ActiveProviderRunHandleOptions['onCleanup'];

  constructor(options: ActiveProviderRunHandleOptions) {
    this.anchorSessionId = options.anchorSessionId;
    this.runId = options.runId;
    this.hostSessionId = options.hostSessionId ?? options.initialTrackingSessionId;
    this.onCleanup = options.onCleanup;
    this.trackingSessionIds.add(options.initialTrackingSessionId);
    this.promptTerminalResolver = new PromptTerminalResolver((result) => {
      this.promptSettled = true;
      this.terminalResult = result;
      this.settleRunIfReady();
      this.tryCleanup();
    });
    this.factDrainTracker = new FactDrainTracker({
      anchorSessionId: options.anchorSessionId,
      runId: options.runId,
      queue: this.queue,
      logger: options.logger,
      onClosed: () => {
        this.factsClosed = true;
        this.settleRunIfReady();
        this.tryCleanup();
      },
    });
  }

  observeTrackingSession(trackingSessionId: string): void {
    this.trackingSessionIds.add(trackingSessionId);
  }

  pushFacts(translation: RawEventTranslation): void {
    if (this.forceClosed || this.factsClosed) {
      return;
    }
    this.factDrainTracker.noteRelevantEvent(translation.terminalCandidateMessageId);
    for (const fact of translation.facts) {
      this.queue.push(fact);
    }
  }

  settlePromptTerminal(result: ProviderTerminalResult): void {
    if (this.forceClosed) {
      return;
    }
    this.promptTerminalResolver.settle(result);
    this.factDrainTracker.onPromptSettled();
  }

  /**
   * 强制结束当前 run，用于 session abort 或宿主侧 aborted terminal 的本地收口。
   */
  forceAbortAndClose(_reason: ForceAbortReason): void {
    if (this.forceClosed) {
      return;
    }
    this.forceClosed = true;
    this.promptSettled = true;
    this.terminalResult = { outcome: 'aborted' };
    this.factsClosed = true;
    this.queue.close();
    this.settleRunIfReady();
    this.tryCleanup();
  }

  result(): Promise<ProviderTerminalResult> {
    return this.completionResolver.result();
  }

  private settleRunIfReady(): void {
    if (!this.promptSettled || !this.factsClosed || !this.terminalResult) {
      return;
    }
    this.completionResolver.settle(this.terminalResult);
  }

  private tryCleanup(): void {
    if (this.cleanedUp || !this.promptSettled || !this.factsClosed) {
      return;
    }
    this.cleanedUp = true;
    this.onCleanup({
      anchorSessionId: this.anchorSessionId,
      runId: this.runId,
      trackingSessionIds: this.trackingSessionIds,
    });
  }
}

export class ActiveRunRegistry {
  private readonly handles = new Map<string, ActiveProviderRunHandle>();
  private readonly hostQueues = new Map<string, ActiveProviderRunHandle[]>();

  create(options: {
    anchorSessionId: string;
    hostSessionId?: string;
    runId: string;
    initialTrackingSessionId: string;
    logger: BridgeLogger;
    onCleanup: (input: {
      anchorSessionId: string;
      runId: string;
      trackingSessionIds: ReadonlySet<string>;
    }) => void;
  }): ActiveProviderRunHandle {
    const hostSessionId = options.hostSessionId ?? options.initialTrackingSessionId;
    const previous = this.handles.get(options.anchorSessionId);
    if (previous) {
      previous.forceAbortAndClose('superseded_run');
      this.removeFromHostQueue(previous);
    }
    const handle = new ActiveProviderRunHandle({
      anchorSessionId: options.anchorSessionId,
      runId: options.runId,
      initialTrackingSessionId: options.initialTrackingSessionId,
      logger: options.logger,
      onCleanup: options.onCleanup,
      hostSessionId,
    });
    this.handles.set(options.anchorSessionId, handle);
    const queue = this.hostQueues.get(hostSessionId) ?? [];
    queue.push(handle);
    this.hostQueues.set(hostSessionId, queue);
    return handle;
  }

  get(anchorSessionId: string): ActiveProviderRunHandle | undefined {
    return this.handles.get(anchorSessionId);
  }

  has(anchorSessionId: string): boolean {
    return this.handles.has(anchorSessionId);
  }

  getHeadByHostSession(hostSessionId: string): ActiveProviderRunHandle | undefined {
    return this.hostQueues.get(hostSessionId)?.[0];
  }

  abortAllByHostSession(
    hostSessionId: string,
    reason: 'abort_session' | 'prompt_terminal_aborted',
  ): ActiveProviderRunHandle[] {
    const queue = [...(this.hostQueues.get(hostSessionId) ?? [])];
    for (const handle of queue) {
      handle.forceAbortAndClose(reason);
      this.handles.delete(handle.anchorSessionId);
    }
    this.hostQueues.delete(hostSessionId);
    return queue;
  }

  private removeFromHostQueue(handle: ActiveProviderRunHandle): void {
    const queue = this.hostQueues.get(handle.hostSessionId) ?? [];
    const nextQueue = queue.filter((queued) => queued !== handle);
    if (nextQueue.length > 0) {
      this.hostQueues.set(handle.hostSessionId, nextQueue);
    } else {
      this.hostQueues.delete(handle.hostSessionId);
    }
  }

  /**
   * 只删除仍属于当前 runId 的 handle。
   * @remarks runId 由 bridge-runtime-sdk 在每次 start_request_run 时生成并保证唯一。
   */
  deleteIfCurrentRun(
    anchorSessionId: string,
    runId: string,
  ): { deleted: boolean; currentRunId?: string } {
    const current = this.handles.get(anchorSessionId);
    if (!current) {
      return { deleted: false };
    }
    if (current.runId !== runId) {
      return {
        deleted: false,
        currentRunId: current.runId,
      };
    }
    this.handles.delete(anchorSessionId);
    this.removeFromHostQueue(current);
    return {
      deleted: true,
      currentRunId: current.runId,
    };
  }
}
