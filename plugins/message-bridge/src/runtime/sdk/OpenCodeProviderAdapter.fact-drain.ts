import type { ProviderFact } from '@wecode/bridge-runtime-sdk';
import type { BridgeLogger } from '../AppLogger.js';
import type { AsyncIterableQueue } from './AsyncIterableQueue.js';

const FACT_DRAIN_QUIET_PERIOD_MS = 40;
const FACT_DRAIN_TIMEOUT_MS = 250;
const FACT_FINAL_IDLE_TIMEOUT_MS = 300_000;

export type FactDrainCloseReason = 'quiet_period' | 'drain_timeout' | 'final_idle_timeout' | 'manual';

type FactDrainTrackerOptions = {
  anchorSessionId: string;
  runId: string;
  queue: AsyncIterableQueue<ProviderFact>;
  logger: BridgeLogger;
  onClosed: () => void;
  canCloseFacts?: () => boolean;
  canFinalIdleTimeout?: () => boolean;
  onFinalIdleTimeout?: () => void;
  quietPeriodMs?: number;
  drainTimeoutMs?: number;
  finalIdleTimeoutMs?: number;
};

/**
 * run 内 fact 流收口器。
 * @remarks
 * 关闭条件：
 * 1. 正常关闭：已观察到 terminal candidate，且 quiet period 内没有新相关事件；
 * 2. active run 额外要求 prompt terminal 已 settle，避免 raw event 早于 `session.prompt` 返回时提前关流；
 * 3. 短兜底：drain timeout 到期，用于没有 terminal candidate 或 terminal 后 quiet 未能收口的异常流；
 * 4. 最终兜底：final idle timeout 到期，用于 prompt 不返回或 open message 长期无有效事件的永久挂起；
 * 5. 手动关闭：上层 abort/cleanup 可直接调用 `closeFacts('manual')`。
 *
 * `canCloseFacts` 是 quiet period 与 drain timeout 共享的关闭资格闸门；未提供时默认允许关闭。
 *
 * final idle watchdog 只由调用方在“有效事件”时刷新；有效事件定义为产出 fact 或 terminal candidate，
 * 空翻译和 unsupported 噪声不会续命。
 */
export class FactDrainTracker {
  private promptSettled = false;
  private closed = false;
  private lastRelevantEventAt = 0;
  private lastTerminalCandidateMessageId?: string;
  private quietTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private finalIdleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: FactDrainTrackerOptions) {}

  noteRelevantEvent(terminalCandidateMessageId?: string): void {
    if (this.closed) {
      return;
    }

    this.lastRelevantEventAt = Date.now();
    if (terminalCandidateMessageId) {
      this.lastTerminalCandidateMessageId = terminalCandidateMessageId;
    }

    if (!this.canArmQuietTimer()) {
      return;
    }

    this.armQuietTimer();
  }

  onPromptSettled(): void {
    if (this.closed || this.promptSettled) {
      return;
    }

    this.promptSettled = true;
    if (this.canArmQuietTimer()) {
      this.armQuietTimer();
    }
    this.armDrainTimer(false);
  }

  startDrainTimeout(input?: { reset?: boolean }): void {
    this.armDrainTimer(Boolean(input?.reset));
  }

  startFinalIdleWatchdog(input?: { reset?: boolean }): void {
    this.armFinalIdleTimer(Boolean(input?.reset));
  }

  refreshEffectiveEventIdleTimer(): void {
    this.armFinalIdleTimer(true);
  }

  closeFacts(reason: FactDrainCloseReason): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeTimers();
    this.options.logger.debug?.('provider_adapter.fact_drain.closed', {
      toolSessionId: this.options.anchorSessionId,
      runId: this.options.runId,
      reason,
      lastTerminalCandidateMessageId: this.lastTerminalCandidateMessageId,
    });
    this.options.queue.close();
    this.options.onClosed();
  }

  private canArmQuietTimer(): boolean {
    if (!this.hasTerminalCandidate()) {
      return false;
    }
    return this.isPromptCloseEligible();
  }

  private armQuietTimer(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
    }
    const quietPeriodMs = this.options.quietPeriodMs ?? FACT_DRAIN_QUIET_PERIOD_MS;
    const elapsedMs = Math.max(0, Date.now() - this.lastRelevantEventAt);
    const delayMs = Math.max(0, quietPeriodMs - elapsedMs);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (!this.canArmQuietTimer()) {
        return;
      }
      if (!this.canCloseFactsNow()) {
        return;
      }
      this.closeFacts('quiet_period');
    }, delayMs);
  }

  private armDrainTimer(reset: boolean): void {
    if (this.drainTimer) {
      if (!reset) {
        return;
      }
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (!this.canCloseFactsNow()) {
        return;
      }
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

  private armFinalIdleTimer(reset: boolean): void {
    if (this.finalIdleTimer) {
      if (!reset) {
        return;
      }
      clearTimeout(this.finalIdleTimer);
      this.finalIdleTimer = null;
    }
    this.finalIdleTimer = setTimeout(() => {
      this.finalIdleTimer = null;
      if (!this.canFinalIdleTimeoutNow()) {
        return;
      }
      this.options.logger.warn('provider_adapter.protocol_diagnostic', {
        toolSessionId: this.options.anchorSessionId,
        runId: this.options.runId,
        code: 'active_run_final_idle_timeout',
        lastTerminalCandidateMessageId: this.lastTerminalCandidateMessageId,
      });
      this.options.onFinalIdleTimeout?.();
      this.closeFacts('final_idle_timeout');
    }, this.options.finalIdleTimeoutMs ?? FACT_FINAL_IDLE_TIMEOUT_MS);
  }

  private hasTerminalCandidate(): boolean {
    return Boolean(this.lastTerminalCandidateMessageId);
  }

  private isPromptCloseEligible(): boolean {
    return this.promptSettled;
  }

  private canCloseFactsNow(): boolean {
    return this.options.canCloseFacts?.() ?? true;
  }

  private canFinalIdleTimeoutNow(): boolean {
    return this.options.canFinalIdleTimeout?.() ?? true;
  }

  private closeTimers(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.finalIdleTimer) {
      clearTimeout(this.finalIdleTimer);
      this.finalIdleTimer = null;
    }
  }
}
