import type { OwnedSessionRepository } from '../../../port/session-isolation/index.js';
import type { OwnedSessionRecord } from '../../../port/session-isolation/dto/records/index.js';

export class InMemoryOwnedSessionRepository implements OwnedSessionRepository {
  private readonly records = new Map<string, OwnedSessionRecord>();

  async findByEntryKey(input: { akScopeKey: string; entryKey: string }): Promise<OwnedSessionRecord[]> {
    return [...this.records.values()].filter(
      (record) => record.akScopeKey === input.akScopeKey && record.entryKey === input.entryKey,
    );
  }

  async findBySessionId(input: { akScopeKey: string; sessionId: string }): Promise<OwnedSessionRecord | undefined> {
    return this.records.get(this.toKey(input.akScopeKey, input.sessionId));
  }

  async upsert(record: OwnedSessionRecord): Promise<void> {
    this.records.set(this.toKey(record.akScopeKey, record.sessionId), record);
  }

  async deleteBySessionId(input: { akScopeKey: string; sessionId: string }): Promise<void> {
    this.records.delete(this.toKey(input.akScopeKey, input.sessionId));
  }

  private toKey(akScopeKey: string, sessionId: string): string {
    return `${akScopeKey}:${sessionId}`;
  }
}
