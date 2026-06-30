import type {
  ProviderFact,
  ProviderTerminalResult,
} from '@wecode/bridge-runtime-sdk';
import type { BridgeLogger } from '../AppLogger.js';
import { AsyncIterableQueue } from './AsyncIterableQueue.js';
import { FactDrainTracker } from './OpenCodeProviderAdapter.fact-drain.js';
import type {
  AssistantMessageLifecycleState,
  AssistantMessageStateStorePort,
  PartKind,
  PartKindStorePort,
  RawEventTranslation,
} from './OpenCodeProviderAdapter.types.js';

type ActiveProviderRunHandleOptions = {
  anchorSessionId: string;
  runId: string;
  initialTrackingSessionId: string;
  logger: BridgeLogger;
  onCleanup: (input: {
    anchorSessionId: string;
    hostSessionId: string;
    runId: string;
    trackingSessionIds: ReadonlySet<string>;
  }) => void;
  hostSessionId?: string;
  finalIdleTimeoutMs?: number;
  canFinalIdleTimeout?: () => boolean;
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
 * assistant message 生命周期状态表。
 * @remarks
 * 用于拒绝没有 open message 的 part/question 事件，避免生成顺序错误的 facts。
 */
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

/**
 * message part 类型记忆表。
 * @remarks
 * `message.part.delta` 不总是携带完整 part 类型，因此需要用先前的 part.updated 判断 text/reasoning。
 */
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

/**
 * 单次 provider run 的 fact 队列、prompt 启动状态和 terminal 收口句柄。
 * @remarks
 * run result 需要 prompt terminal 与 facts drain 都完成；cleanup 还要等待已启动的 prompt task 返回，
 * 以便 `HostSessionRunCoordinator` 在同一 host session 内维持 FIFO prompt 调度。
 */
export class ActiveProviderRunHandle {
  readonly queue = new AsyncIterableQueue<ProviderFact>();
  readonly logger: BridgeLogger;
  private readonly trackingSessionIds = new Set<string>();
  private readonly promptTerminalResolver: PromptTerminalResolver;
  private readonly completionResolver = new RunCompletionResolver();
  private readonly finalIdleTimeoutResolver = createDeferred<void>();
  private readonly factDrainTracker: FactDrainTracker;
  private promptStarted = false;
  private promptTaskFinished = false;
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
    this.logger = options.logger;
    this.onCleanup = options.onCleanup;
    this.trackingSessionIds.add(options.initialTrackingSessionId);
    this.promptTerminalResolver = new PromptTerminalResolver((result) => {
      this.promptSettled = true;
      this.terminalResult = result;
      this.settleRunIfReady();
      this.tryCleanup();
    });
    this.factDrainTracker = new FactDrainTracker({
      mode: 'active_run',
      anchorSessionId: options.anchorSessionId,
      runId: options.runId,
      queue: this.queue,
      logger: options.logger,
      finalIdleTimeoutMs: options.finalIdleTimeoutMs,
      canFinalIdleTimeout: options.canFinalIdleTimeout,
      onFinalIdleTimeout: () => {
        this.forceTimeoutAndClose();
      },
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

  /**
   * 标记 prompt 已进入宿主调用阶段。
   * @remarks scheduler 必须以 handle 自身状态为准，避免 queued run 已被 abort/close/supersede 后仍启动 prompt。
   */
  tryStartPrompt(): boolean {
    if (this.promptStarted || this.forceClosed || this.promptSettled || this.factsClosed) {
      return false;
    }
    this.promptStarted = true;
    this.factDrainTracker.startFinalIdleWatchdog();
    return true;
  }

  /**
   * 判断 queued run 是否仍可启动宿主 prompt。
   */
  canStartPrompt(): boolean {
    return !this.promptStarted && !this.forceClosed && !this.promptSettled && !this.factsClosed;
  }

  hasPromptStarted(): boolean {
    return this.promptStarted;
  }

  /**
   * 标记宿主 prompt task 已返回。
   * @remarks running run 被 supersede 时本地 result 会先 abort，但路由队首要等底层 prompt task 返回后才能释放。
   */
  markPromptTaskFinished(): void {
    if (!this.promptStarted || this.promptTaskFinished) {
      return;
    }
    this.promptTaskFinished = true;
    this.tryCleanup();
  }

  pushFacts(translation: RawEventTranslation): void {
    if (this.forceClosed || this.factsClosed) {
      return;
    }
    if (this.isEffectiveTranslation(translation)) {
      this.factDrainTracker.refreshEffectiveEventIdleTimer();
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
    this.factDrainTracker.closeFacts('manual');
    this.tryCleanup();
  }

  /**
   * prompt task 自身异常时 fail-closed，避免 scheduler 永久卡住同一 host session。
   */
  forceFailAndClose(error: { code: 'internal_error'; message: string }): void {
    if (this.forceClosed) {
      return;
    }
    this.forceClosed = true;
    this.promptSettled = true;
    this.terminalResult = { outcome: 'failed', error };
    this.factDrainTracker.closeFacts('manual');
    this.tryCleanup();
  }

  /**
   * prompt 长时间无有效事件时 fail-closed，避免同一 host session 的队列永久阻塞。
   */
  forceTimeoutAndClose(): void {
    if (this.forceClosed) {
      return;
    }
    this.logger.warn('provider_adapter.active_run_final_idle_timeout', {
      anchorSessionId: this.anchorSessionId,
      hostSessionId: this.hostSessionId,
      runId: this.runId,
    });
    this.forceClosed = true;
    this.promptSettled = true;
    this.promptTaskFinished = true;
    this.terminalResult = {
      outcome: 'failed',
      error: {
        code: 'timeout',
        message: 'provider_run_final_idle_timeout',
        retryable: true,
      },
    };
    this.finalIdleTimeoutResolver.resolve();
    this.tryCleanup();
  }

  result(): Promise<ProviderTerminalResult> {
    return this.completionResolver.result();
  }

  waitPromptFinalIdleTimeout(): Promise<void> {
    return this.finalIdleTimeoutResolver.promise;
  }

  hasForceClosed(): boolean {
    return this.forceClosed;
  }

  /**
   * pending question/permission 状态变化后恢复 final idle 计时。
   * @remarks registry 是 pending 事实源；当前 run 只负责在 gate 放行后重新 arm 本地 watchdog。
   */
  onPendingInteractionChanged(): void {
    if (!this.promptStarted || this.forceClosed || this.promptSettled || this.factsClosed) {
      return;
    }
    this.factDrainTracker.startFinalIdleWatchdog({ reset: true });
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
    if (this.promptStarted && !this.promptTaskFinished) {
      return;
    }
    this.cleanedUp = true;
    this.onCleanup({
      anchorSessionId: this.anchorSessionId,
      hostSessionId: this.hostSessionId,
      runId: this.runId,
      trackingSessionIds: this.trackingSessionIds,
    });
  }

  private isEffectiveTranslation(translation: RawEventTranslation): boolean {
    return translation.facts.length > 0 || Boolean(translation.terminalCandidateMessageId);
  }
}

/**
 * active run 注册表。
 * @remarks
 * 对外按 anchor session 管理当前 run，对内按 host session 维护事件路由队列；
 * 已启动 prompt 的 superseded run 会保留到 task finished，未启动的 queued run 可直接移出队列。
 */
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
      hostSessionId: string;
      runId: string;
      trackingSessionIds: ReadonlySet<string>;
    }) => void;
    finalIdleTimeoutMs?: number;
    canFinalIdleTimeout: (input: { hostSessionId: string; runId: string }) => boolean;
  }): ActiveProviderRunHandle {
    const hostSessionId = options.hostSessionId ?? options.initialTrackingSessionId;
    const previous = this.handles.get(options.anchorSessionId);
    const handle = new ActiveProviderRunHandle({
      anchorSessionId: options.anchorSessionId,
      runId: options.runId,
      initialTrackingSessionId: options.initialTrackingSessionId,
      logger: options.logger,
      onCleanup: options.onCleanup,
      hostSessionId,
      canFinalIdleTimeout: () => options.canFinalIdleTimeout({ hostSessionId, runId: options.runId }),
      ...(options.finalIdleTimeoutMs !== undefined ? { finalIdleTimeoutMs: options.finalIdleTimeoutMs } : {}),
    });
    this.handles.set(options.anchorSessionId, handle);
    const queue = this.hostQueues.get(hostSessionId) ?? [];
    queue.push(handle);
    this.hostQueues.set(hostSessionId, queue);
    if (previous) {
      const previousPromptStarted = previous.hasPromptStarted();
      options.logger.debug?.('provider_adapter.active_run.superseded', {
        anchorSessionId: options.anchorSessionId,
        hostSessionId,
        previousRunId: previous.runId,
        nextRunId: options.runId,
        previousPromptStarted,
      });
      previous.forceAbortAndClose('superseded_run');
      if (!previousPromptStarted) {
        this.removeFromHostQueue(previous);
        options.logger.debug?.('provider_adapter.active_run.removed_unstarted_superseded_run', {
          anchorSessionId: previous.anchorSessionId,
          hostSessionId: previous.hostSessionId,
          runId: previous.runId,
        });
      }
    }
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

  notifyRunPendingChanged(input: { hostSessionId: string; runId: string }): void {
    const handle = (this.hostQueues.get(input.hostSessionId) ?? [])
      .find((queued) => queued.runId === input.runId);
    handle?.onPendingInteractionChanged();
  }

  abortAllByHostSession(
    hostSessionId: string,
    reason: 'abort_session' | 'prompt_terminal_aborted',
  ): ActiveProviderRunHandle[] {
    const queue = [...(this.hostQueues.get(hostSessionId) ?? [])];
    for (const handle of queue) {
      const promptStarted = handle.hasPromptStarted();
      handle.forceAbortAndClose(reason);
      this.handles.delete(handle.anchorSessionId);
      handle.logger.debug?.('provider_adapter.active_run.host_run_aborted', {
        anchorSessionId: handle.anchorSessionId,
        hostSessionId,
        runId: handle.runId,
        reason,
        promptStarted,
      });
      if (!promptStarted) {
        this.removeFromHostQueue(handle);
      }
    }
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

  abortByAnchorSession(anchorSessionId: string, reason: ForceAbortReason): ActiveProviderRunHandle | undefined {
    const current = this.handles.get(anchorSessionId);
    if (!current) {
      return undefined;
    }
    const promptStarted = current.hasPromptStarted();
    current.forceAbortAndClose(reason);
    this.handles.delete(anchorSessionId);
    if (!promptStarted) {
      this.removeFromHostQueue(current);
    }
    return current;
  }

  removeHostQueueEntry(hostSessionId: string, runId: string): void {
    const queue = this.hostQueues.get(hostSessionId) ?? [];
    const nextQueue = queue.filter((handle) => handle.runId !== runId);
    if (nextQueue.length > 0) {
      this.hostQueues.set(hostSessionId, nextQueue);
    } else {
      this.hostQueues.delete(hostSessionId);
    }
  }
}
