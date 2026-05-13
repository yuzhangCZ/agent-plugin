import type { BridgeLogger } from '../AppLogger.js';

export type ToolDoneSource = 'invoke_complete' | 'session_idle';

interface InvokeLifecycleInput {
  action: string;
  toolSessionId?: string;
}

interface SessionIdleInput {
  toolSessionId: string;
  logger: BridgeLogger;
}

interface ToolDoneEmissionInput {
  toolSessionId: string;
  source: ToolDoneSource;
  logger: BridgeLogger;
}

export interface ToolDoneDecision {
  emit: boolean;
  source?: ToolDoneSource;
}

export class ToolDoneCompat {
  private readonly trackedSessions = new Set<string>();
  private readonly pendingPromptSessions = new Set<string>();
  private readonly completedSessionsAwaitingIdleDrop = new Set<string>();

  handleInvokeStarted(input: InvokeLifecycleInput): void {
    if (input.action !== 'chat' || !input.toolSessionId) {
      return;
    }

    this.trackedSessions.add(input.toolSessionId);
    this.pendingPromptSessions.add(input.toolSessionId);
  }

  handleInvokeFailed(input: InvokeLifecycleInput): void {
    if (input.action !== 'chat' || !input.toolSessionId) {
      return;
    }

    this.pendingPromptSessions.delete(input.toolSessionId);
    this.completedSessionsAwaitingIdleDrop.delete(input.toolSessionId);
    this.trackedSessions.delete(input.toolSessionId);
  }

  handleInvokeCompleted(input: InvokeLifecycleInput & { logger: BridgeLogger }): ToolDoneDecision {
    const { action, toolSessionId, logger } = input;
    if (action !== 'chat') {
      return { emit: false };
    }

    if (!toolSessionId) {
      logger.warn('compat.tool_done.skipped_missing_session', {
        action,
        source: 'invoke_complete',
      });
      return { emit: false };
    }

    this.pendingPromptSessions.delete(toolSessionId);
    return {
      emit: true,
      source: 'invoke_complete',
    };
  }

  handleSessionIdle(input: SessionIdleInput): ToolDoneDecision {
    const { toolSessionId, logger } = input;
    if (!this.trackedSessions.has(toolSessionId)) {
      logger.debug('compat.tool_done.skipped_untracked', {
        toolSessionId,
        source: 'session_idle',
      });
      return { emit: false };
    }

    if (this.pendingPromptSessions.has(toolSessionId)) {
      logger.debug('compat.tool_done.deferred_pending', {
        toolSessionId,
        source: 'session_idle',
      });
      return { emit: false };
    }

    if (this.completedSessionsAwaitingIdleDrop.has(toolSessionId)) {
      this.completedSessionsAwaitingIdleDrop.delete(toolSessionId);
      this.trackedSessions.delete(toolSessionId);
      logger.debug('compat.tool_done.skipped_duplicate', {
        toolSessionId,
        source: 'session_idle',
      });
      return { emit: false };
    }

    logger.info('compat.tool_done.fallback_from_idle', {
      toolSessionId,
      source: 'session_idle',
    });
    return {
      emit: true,
      source: 'session_idle',
    };
  }

  handleToolDoneSent(input: ToolDoneEmissionInput): void {
    if (input.source === 'invoke_complete') {
      this.completedSessionsAwaitingIdleDrop.add(input.toolSessionId);
    } else {
      this.completedSessionsAwaitingIdleDrop.delete(input.toolSessionId);
      this.trackedSessions.delete(input.toolSessionId);
    }

    input.logger.info('compat.tool_done.sent', {
      toolSessionId: input.toolSessionId,
      source: input.source,
    });
  }

  handleToolDoneSendFailed(input: ToolDoneEmissionInput): void {
    input.logger.warn('compat.tool_done.send_failed', {
      toolSessionId: input.toolSessionId,
      source: input.source,
    });
  }
}
