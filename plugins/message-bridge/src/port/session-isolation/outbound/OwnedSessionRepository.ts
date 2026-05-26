import type { OwnedSessionRecord } from '../dto/records/index.js';

export interface OwnedSessionRepository {
  findByEntryKey(input: { akScopeKey: string; entryKey: string }): Promise<OwnedSessionRecord[]>;
  findBySessionId(input: { akScopeKey: string; sessionId: string }): Promise<OwnedSessionRecord | undefined>;
  upsert(record: OwnedSessionRecord): Promise<void>;
  deleteBySessionId(input: { akScopeKey: string; sessionId: string }): Promise<void>;
}
