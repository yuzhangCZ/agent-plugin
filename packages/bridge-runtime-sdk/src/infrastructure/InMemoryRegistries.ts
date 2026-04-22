import type {
  PendingInteractionRecord,
  PendingInteractionRegistry,
  SessionRuntimeRecord,
  SessionRuntimeRegistry,
} from '../application/registries.ts';

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
      lifecycle: 'active',
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

  acquireActiveRun(toolSessionId: string, runId: string): { ok: true; record: SessionRuntimeRecord } | { ok: false } {
    const record = this.ensure({ toolSessionId });
    if (record.activeRunId || record.lifecycle === 'closed') {
      return { ok: false };
    }
    record.activeRunId = runId;
    return { ok: true, record };
  }

  releaseActiveRun(toolSessionId: string, runId: string): void {
    const record = this.records.get(toolSessionId);
    if (record?.activeRunId === runId) {
      delete record.activeRunId;
    }
  }

  acquireActiveOutbound(toolSessionId: string, messageId: string): { ok: true; record: SessionRuntimeRecord } | { ok: false } {
    const record = this.ensure({ toolSessionId });
    if (record.activeOutboundMessageId || record.lifecycle === 'closed') {
      return { ok: false };
    }
    record.activeOutboundMessageId = messageId;
    return { ok: true, record };
  }

  releaseActiveOutbound(toolSessionId: string, messageId: string): void {
    const record = this.records.get(toolSessionId);
    if (record?.activeOutboundMessageId === messageId) {
      delete record.activeOutboundMessageId;
    }
  }

  markAborting(toolSessionId: string): SessionRuntimeRecord | undefined {
    const record = this.records.get(toolSessionId);
    if (record) {
      record.lifecycle = 'aborting';
    }
    return record;
  }

  markClosed(toolSessionId: string): SessionRuntimeRecord | undefined {
    const record = this.records.get(toolSessionId);
    if (record) {
      record.lifecycle = 'closed';
    }
    return record;
  }
}

/**
 * 默认 in-memory pending interaction registry。
 */
export class InMemoryPendingInteractionRegistry implements PendingInteractionRegistry {
  private readonly records = new Map<string, PendingInteractionRecord>();

  register(record: PendingInteractionRecord): { ok: true } | { ok: false } {
    const key = this.toKey(record.toolSessionId, record.kind, record.tokenId);
    if (this.records.has(key)) {
      return { ok: false };
    }
    this.records.set(key, record);
    return { ok: true };
  }

  consume(input: { toolSessionId: string; kind: PendingInteractionRecord['kind']; tokenId: string }): PendingInteractionRecord | undefined {
    const key = this.toKey(input.toolSessionId, input.kind, input.tokenId);
    const record = this.records.get(key);
    if (record) {
      this.records.delete(key);
    }
    return record;
  }

  clearSession(toolSessionId: string): void {
    for (const [key, record] of this.records.entries()) {
      if (record.toolSessionId === toolSessionId) {
        this.records.delete(key);
      }
    }
  }

  private toKey(toolSessionId: string, kind: PendingInteractionRecord['kind'], tokenId: string): string {
    return `${toolSessionId}:${kind}:${tokenId}`;
  }
}
