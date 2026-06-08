import type { ProviderFact, ProviderRuntimeContext } from '@wecode/bridge-runtime-sdk';
import type { BridgeLogger } from '../AppLogger.js';
import { AsyncIterableQueue } from './AsyncIterableQueue.js';
import { FactDrainTracker } from './OpenCodeProviderAdapter.fact-drain.js';
import type { FactSessionContext, RawEventTranslation } from './OpenCodeProviderAdapter.types.js';

type TuiOutboundRunHandleOptions = {
  hostSessionId: string;
  anchorSessionId: string;
  runId: string;
  runtimeContext: ProviderRuntimeContext;
  logger: BridgeLogger;
  finalIdleTimeoutMs?: number;
  onEmissionSettled: (input: {
    hostSessionId: string;
    runId: string;
    trackingSessionIds: ReadonlySet<string>;
  }) => void;
  onFinalIdleTimeout: (input: {
    hostSessionId: string;
    runId: string;
    trackingSessionIds: ReadonlySet<string>;
  }) => void;
};

/**
 * TUI outbound run 的轻量 facts 流句柄。
 * @remarks
 * 复用 active run 的 fact drain 边界，但不承载 prompt/result 状态机。
 * 一轮 TUI 对话可能包含多个 assistant message；只要还有 open message，
 * quiet period 与 drain timeout 都不能关闭 facts 流，避免后续 part 被拆到新 run。
 */
class TuiOutboundRunHandle {
  private readonly queue = new AsyncIterableQueue<ProviderFact>();
  private readonly factDrainTracker: FactDrainTracker;
  private readonly openMessageIds = new Set<string>();
  private readonly trackingSessionIds = new Set<string>();
  private readonly emissionSettledPromise: Promise<void>;
  private resolveEmissionSettled!: () => void;
  private factsClosed = false;
  private emissionSettled = false;
  // 终态候选是 outbound run 的分轮边界：本轮不再吸收新 translation，等待 quiet/drain 与 SDK emission settle。
  private terminalCloseCandidateObserved = false;

  readonly hostSessionId: string;
  readonly anchorSessionId: string;
  readonly runId: string;

  constructor(private readonly options: TuiOutboundRunHandleOptions) {
    this.hostSessionId = options.hostSessionId;
    this.anchorSessionId = options.anchorSessionId;
    this.runId = options.runId;
    this.emissionSettledPromise = new Promise((resolve) => {
      this.resolveEmissionSettled = resolve;
    });
    this.factDrainTracker = new FactDrainTracker({
      mode: 'outbound_run',
      anchorSessionId: this.anchorSessionId,
      runId: this.runId,
      queue: this.queue,
      logger: this.options.logger,
      ...(options.finalIdleTimeoutMs !== undefined ? { finalIdleTimeoutMs: options.finalIdleTimeoutMs } : {}),
      onClosed: () => {
        this.factsClosed = true;
      },
      canCloseFacts: () => this.openMessageIds.size === 0,
      onFinalIdleTimeout: () => {
        this.options.logger.warn('provider_adapter.protocol_diagnostic', {
          toolSessionId: this.anchorSessionId,
          runId: this.runId,
          code: 'outbound_open_message_idle_timeout',
          messageIds: [...this.openMessageIds],
        });
        this.options.onFinalIdleTimeout({
          hostSessionId: this.hostSessionId,
          runId: this.runId,
          trackingSessionIds: this.trackingSessionIds,
        });
      },
    });
    void this.options.runtimeContext.outbound.emitOutboundRun!({
      toolSessionId: this.anchorSessionId,
      runId: this.runId,
      trigger: 'system',
      facts: this.queue,
    }).catch((error) => {
      this.options.logger.warn('provider_adapter.tui_outbound_run_failed', {
        hostSessionId: this.hostSessionId,
        toolSessionId: this.anchorSessionId,
        runId: this.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      this.emissionSettled = true;
      this.resolveEmissionSettled();
      this.options.onEmissionSettled({
        hostSessionId: this.hostSessionId,
        runId: this.runId,
        trackingSessionIds: this.trackingSessionIds,
      });
    });
  }

  pushTranslation(input: { translation: RawEventTranslation; trackingSessionId: string }): void {
    if (!this.canAcceptTranslation()) {
      return;
    }
    this.trackingSessionIds.add(input.trackingSessionId);
    this.trackOpenMessages(input.translation.facts);
    if (input.translation.terminalCandidateMessageId && this.openMessageIds.size === 0) {
      this.terminalCloseCandidateObserved = true;
    }
    if (this.openMessageIds.size > 0) {
      this.factDrainTracker.startFinalIdleWatchdog();
    }
    if (this.isEffectiveTranslation(input.translation)) {
      this.factDrainTracker.refreshEffectiveEventIdleTimer();
    }
    this.factDrainTracker.noteRelevantEvent(input.translation.terminalCandidateMessageId);
    this.factDrainTracker.startDrainTimeout({ reset: true });
    for (const fact of input.translation.facts) {
      this.queue.push(fact);
    }
  }

  close(reason: 'quiet_period' | 'drain_timeout' | 'final_idle_timeout' | 'manual'): void {
    this.factDrainTracker.closeFacts(reason);
  }

  canAcceptTranslation(): boolean {
    return !this.factsClosed && !this.emissionSettled && !this.terminalCloseCandidateObserved;
  }

  isEmissionSettled(): boolean {
    return this.emissionSettled;
  }

  waitEmissionSettled(): Promise<void> {
    return this.emissionSettledPromise;
  }

  private trackOpenMessages(facts: ProviderFact[]): void {
    for (const fact of facts) {
      if ('messageId' in fact && typeof fact.messageId === 'string') {
        if (fact.type === 'message.start') {
          this.openMessageIds.add(fact.messageId);
          continue;
        }
        if (fact.type === 'message.done') {
          this.openMessageIds.delete(fact.messageId);
        }
      }
    }
  }

  private isEffectiveTranslation(translation: RawEventTranslation): boolean {
    return translation.facts.length > 0 || Boolean(translation.terminalCandidateMessageId);
  }

}

type PendingOutboundTranslation = {
  hostSessionId: string;
  anchorSessionId: string;
  factSessionContext: FactSessionContext;
  runtimeContext: ProviderRuntimeContext;
  translation: RawEventTranslation;
};

type HostOutboundState = {
  current?: TuiOutboundRunHandle;
  queue: PendingOutboundTranslation[];
  draining: boolean;
};

type TuiOutboundRunRegistryOptions = {
  logger: BridgeLogger;
  finalIdleTimeoutMs?: number;
  onFinalIdleTimeout: (input: {
    hostSessionId: string;
    runId: string;
    trackingSessionIds: ReadonlySet<string>;
  }) => void;
  onTranslationAccepted: (input: {
    hostSessionId: string;
    anchorSessionId: string;
    runId: string;
    facts: ProviderFact[];
    factSessionContext: FactSessionContext;
  }) => void;
};

/**
 * 按 host session 管理 TUI outbound run。
 */
export class TuiOutboundRunRegistry {
  private readonly hostStates = new Map<string, HostOutboundState>();
  private nextRunSeq = 0;

  constructor(private readonly options: TuiOutboundRunRegistryOptions) {}

  push(input: {
    hostSessionId: string;
    anchorSessionId: string;
    factSessionContext: FactSessionContext;
    runtimeContext: ProviderRuntimeContext;
    translation: RawEventTranslation;
  }): void {
    const state = this.ensureHostState(input.hostSessionId);
    state.queue.push(input);
    void this.drain(input.hostSessionId);
  }

  closeByHostSession(hostSessionId: string): void {
    const state = this.hostStates.get(hostSessionId);
    if (!state) {
      return;
    }
    state.queue = [];
    state.current?.close('manual');
  }

  private pushToHandle(handle: TuiOutboundRunHandle, input: PendingOutboundTranslation): void {
    if (handle.anchorSessionId !== input.anchorSessionId) {
      this.options.logger.debug?.('provider_adapter.tui_outbound_run_anchor_locked', {
        hostSessionId: input.hostSessionId,
        runId: handle.runId,
        lockedAnchorSessionId: handle.anchorSessionId,
        resolvedAnchorSessionId: input.anchorSessionId,
      });
    }
    handle.pushTranslation({
      translation: input.translation,
      trackingSessionId: input.factSessionContext.trackingSessionId,
    });
    this.options.onTranslationAccepted({
      hostSessionId: input.hostSessionId,
      anchorSessionId: handle.anchorSessionId,
      runId: handle.runId,
      facts: input.translation.facts,
      factSessionContext: {
        ...input.factSessionContext,
        anchorSessionId: handle.anchorSessionId,
      },
    });
  }

  private createHandle(input: {
    hostSessionId: string;
    anchorSessionId: string;
    runtimeContext: ProviderRuntimeContext;
  }): TuiOutboundRunHandle {
    this.nextRunSeq += 1;
    const runId = `tui-outbound-run:${input.hostSessionId}:${this.nextRunSeq}`;
    const handle = new TuiOutboundRunHandle({
      hostSessionId: input.hostSessionId,
      anchorSessionId: input.anchorSessionId,
      runId,
      runtimeContext: input.runtimeContext,
      logger: this.options.logger,
      ...(this.options.finalIdleTimeoutMs !== undefined ? { finalIdleTimeoutMs: this.options.finalIdleTimeoutMs } : {}),
      onFinalIdleTimeout: this.options.onFinalIdleTimeout,
      onEmissionSettled: ({ hostSessionId, runId: closedRunId }) => {
        const state = this.hostStates.get(hostSessionId);
        if (state?.current?.runId === closedRunId && state.queue.length > 0) {
          void this.drain(hostSessionId);
        }
      },
    });
    return handle;
  }

  private ensureHostState(hostSessionId: string): HostOutboundState {
    let state = this.hostStates.get(hostSessionId);
    if (!state) {
      state = {
        queue: [],
        draining: false,
      };
      this.hostStates.set(hostSessionId, state);
    }
    return state;
  }

  private async drain(hostSessionId: string): Promise<void> {
    const state = this.ensureHostState(hostSessionId);
    if (state.draining) {
      return;
    }

    state.draining = true;
    try {
      while (state.queue.length > 0) {
        if (state.current) {
          if (state.current.canAcceptTranslation()) {
            const next = state.queue.shift();
            if (!next) {
              continue;
            }
            this.pushToHandle(state.current, next);
            continue;
          }
          await state.current.waitEmissionSettled();
          state.current = undefined;
          continue;
        }

        const next = state.queue[0];
        if (!next) {
          continue;
        }
        state.current = this.createHandle(next);
      }
    } finally {
      state.draining = false;
      if (state.queue.length > 0) {
        void this.drain(hostSessionId);
      }
    }
  }
}
