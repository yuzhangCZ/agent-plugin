import type {
  SessionRuntimeRecord,
  SessionRuntimeRegistry,
} from '../../application/ports/session-runtime-registry.ts';

/**
 * 默认 in-memory session registry。
 */
export class InMemorySessionRuntimeRegistry implements SessionRuntimeRegistry {
  private readonly records = new Map<string, SessionRuntimeRecord>();

  ensure(input: { toolSessionId: string; welinkSessionId?: string }): SessionRuntimeRecord {
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
      requestRun: { status: 'idle' },
      outbound: { status: 'idle' },
    };
    this.records.set(input.toolSessionId, created);
    return created;
  }

  get(toolSessionId: string): SessionRuntimeRecord | undefined {
    return this.records.get(toolSessionId);
  }

  delete(toolSessionId: string): void {
    this.records.delete(toolSessionId);
  }

  acquireRequestRun(toolSessionId: string, runId: string): { ok: true; record: SessionRuntimeRecord } | { ok: false } {
    const record = this.ensure({ toolSessionId });
    if (record.requestRun.status !== 'idle') {
      return { ok: false };
    }
    record.requestRun = { status: 'running', runId };
    return { ok: true, record };
  }

  releaseRequestRun(toolSessionId: string, runId: string): void {
    const record = this.records.get(toolSessionId);
    if (record?.requestRun.status === 'running' && record.requestRun.runId === runId) {
      record.requestRun = { status: 'idle' };
    }
  }

  getRequestRunState(toolSessionId: string) {
    return this.records.get(toolSessionId)?.requestRun ?? { status: 'idle' };
  }

  getActiveRequestRunId(toolSessionId: string): string | undefined {
    const requestRun = this.getRequestRunState(toolSessionId);
    return requestRun.status === 'running' ? requestRun.runId : undefined;
  }

  acquireOutboundEmission(toolSessionId: string, messageId: string): { ok: true; record: SessionRuntimeRecord } | { ok: false } {
    const record = this.ensure({ toolSessionId });
    if (record.outbound.status !== 'idle') {
      return { ok: false };
    }
    record.outbound = { status: 'emitting', messageId };
    return { ok: true, record };
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
