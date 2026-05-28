import type {
  PendingInteractionRecord,
  PendingInteractionRegistry,
} from '../../application/ports/pending-interaction-registry.ts';

/**
 * 默认 in-memory pending interaction registry。
 */
export class InMemoryPendingInteractionRegistry implements PendingInteractionRegistry {
  private readonly records = new Map<string, PendingInteractionRecord>();

  register(record: PendingInteractionRecord): { ok: true } | { ok: false; reason: 'duplicate_same_session' } | { ok: false; reason: 'conflict_cross_session'; conflict: { current: PendingInteractionRecord; existing: PendingInteractionRecord } } {
    const key = this.toKey(record.kind, record.tokenId);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.toolSessionId === record.toolSessionId) {
        return { ok: false, reason: 'duplicate_same_session' };
      }
      return { ok: false, reason: 'conflict_cross_session', conflict: { current: record, existing } };
    }
    this.records.set(key, record);
    return { ok: true };
  }

  consume(input: {
    kind: PendingInteractionRecord['kind'];
    tokenId: string;
  }): PendingInteractionRecord | undefined {
    const key = this.toKey(input.kind, input.tokenId);
    const record = this.records.get(key);
    if (record) {
      this.records.delete(key);
    }
    return record;
  }

  private toKey(kind: PendingInteractionRecord['kind'], tokenId: string): string {
    return `${kind}:${tokenId}`;
  }
}
