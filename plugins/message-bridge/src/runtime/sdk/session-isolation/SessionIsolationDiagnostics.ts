import type { BridgeLogger } from '../../AppLogger.js';
import type {
  SessionIsolationDiagnosticEvent,
  SessionIsolationDiagnosticsPort,
} from '../../../port/session-isolation/outbound/index.js';

export type SessionIsolationDiagnosticsSnapshot = {
  counters: Partial<Record<SessionIsolationDiagnosticEvent['kind'], number>>;
  lastEvent: SessionIsolationDiagnosticEvent | null;
  updatedAt: number | null;
};

/**
 * session-isolation 诊断收集器。
 * @remarks 同时提供内存快照和结构化日志，供状态排查使用；不会改变 runtime ready/unavailable 状态。
 */
export class SessionIsolationDiagnostics implements SessionIsolationDiagnosticsPort {
  private readonly counters: Partial<Record<SessionIsolationDiagnosticEvent['kind'], number>> = {};
  private lastEvent: SessionIsolationDiagnosticEvent | null = null;
  private updatedAt: number | null = null;

  constructor(private readonly options: {
    logger?: BridgeLogger;
    now?: () => number;
  } = {}) {}

  record(event: SessionIsolationDiagnosticEvent): void {
    this.counters[event.kind] = (this.counters[event.kind] ?? 0) + 1;
    this.lastEvent = event;
    this.updatedAt = this.options.now?.() ?? Date.now();
    this.writeLog(event);
  }

  getSnapshot(): SessionIsolationDiagnosticsSnapshot {
    return {
      counters: { ...this.counters },
      lastEvent: this.lastEvent ? { ...this.lastEvent } : null,
      updatedAt: this.updatedAt,
    };
  }

  private writeLog(event: SessionIsolationDiagnosticEvent): void {
    const logger = this.options.logger;
    if (!logger) {
      return;
    }
    const extra = {
      diagnosticKind: event.kind,
      ...event,
    };
    if (event.severity === 'error') {
      logger.error('session_isolation.diagnostic', extra);
      return;
    }
    logger.warn('session_isolation.diagnostic', extra);
  }
}
