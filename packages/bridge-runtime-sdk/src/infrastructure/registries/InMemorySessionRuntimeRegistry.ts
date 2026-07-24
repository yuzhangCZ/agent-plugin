import type {
  RequestRunState,
  SessionRuntimeRecord,
  SessionRuntimeRegistry,
} from '../../application/ports/session-runtime-registry.ts';

/**
 * 默认 in-memory session registry。
 */
export class InMemorySessionRuntimeRegistry implements SessionRuntimeRegistry {
  private readonly records = new Map<string, SessionRuntimeRecord>();

  private snapshotRequestRunState(state: RequestRunState): RequestRunState {
    return { activeRunIds: [...state.activeRunIds] };
  }

  private snapshotRecord(record: SessionRuntimeRecord): SessionRuntimeRecord {
    return {
      toolSessionId: record.toolSessionId,
      ...(record.welinkSessionId ? { welinkSessionId: record.welinkSessionId } : {}),
      requestRun: this.snapshotRequestRunState(record.requestRun),
      outbound: { ...record.outbound },
    };
  }

  private ensureRecord(input: { toolSessionId: string; welinkSessionId?: string }): SessionRuntimeRecord {
    const existing = this.records.get(input.toolSessionId);
    if (existing) {
      if (input.welinkSessionId && !existing.welinkSessionId) {
        existing.welinkSessionId = input.welinkSessionId;
      }
      return existing;
    }

    const created: SessionRuntimeRecord = {
      toolSessionId: input.toolSessionId,
      ...(input.welinkSessionId ? { welinkSessionId: input.welinkSessionId } : {}),
      requestRun: { activeRunIds: [] },
      outbound: { status: 'idle' },
    };
    this.records.set(input.toolSessionId, created);
    return created;
  }

  ensure(input: { toolSessionId: string; welinkSessionId?: string }): SessionRuntimeRecord {
    return this.snapshotRecord(this.ensureRecord(input));
  }

  get(toolSessionId: string): SessionRuntimeRecord | undefined {
    const record = this.records.get(toolSessionId);
    return record ? this.snapshotRecord(record) : undefined;
  }

  delete(toolSessionId: string): void {
    this.records.delete(toolSessionId);
  }

  registerRequestRun(toolSessionId: string, runId: string): RequestRunState {
    const record = this.ensureRecord({ toolSessionId });
    if (!record.requestRun.activeRunIds.includes(runId)) {
      record.requestRun = { activeRunIds: [...record.requestRun.activeRunIds, runId] };
    }
    return this.snapshotRequestRunState(record.requestRun);
  }

  releaseRequestRun(toolSessionId: string, runId: string): RequestRunState {
    const record = this.records.get(toolSessionId);
    if (!record) {
      return this.snapshotRequestRunState({ activeRunIds: [] });
    }
    if (record.requestRun.activeRunIds.includes(runId)) {
      record.requestRun = {
        activeRunIds: record.requestRun.activeRunIds.filter((activeRunId) => activeRunId !== runId),
      };
    }
    return this.snapshotRequestRunState(record.requestRun);
  }

  getRequestRunState(toolSessionId: string): RequestRunState {
    return this.snapshotRequestRunState(this.records.get(toolSessionId)?.requestRun ?? { activeRunIds: [] });
  }

  acquireOutboundEmission(toolSessionId: string, messageId: string): { ok: true; record: SessionRuntimeRecord } | { ok: false } {
    const record = this.ensureRecord({ toolSessionId });
    if (record.outbound.status !== 'idle') {
      return { ok: false };
    }
    record.outbound = { status: 'emitting', messageId };
    return { ok: true, record: this.snapshotRecord(record) };
  }

  releaseOutboundEmission(toolSessionId: string, messageId: string): void {
    const record = this.records.get(toolSessionId);
    if (record?.outbound.status === 'emitting' && record.outbound.messageId === messageId) {
      record.outbound = { status: 'idle' };
    }
  }

  getOutboundEmissionState(toolSessionId: string) {
    return this.records.get(toolSessionId)?.outbound ?? { status: 'idle' };
  }
}
