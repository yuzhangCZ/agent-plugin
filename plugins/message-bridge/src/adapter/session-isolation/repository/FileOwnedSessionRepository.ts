import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import type { OwnedSessionRepository } from '../../../port/session-isolation/index.js';
import type { OwnedSessionRecord } from '../../../port/session-isolation/dto/records/index.js';
import type { SessionIsolationDiagnosticsPort } from '../../../port/session-isolation/outbound/index.js';

type PersistedSessionRecord = {
  origin: 'welink-entry-owned';
  entryKey: string;
  controlled: boolean;
  permissionProfile: 'default' | 'dialog_only';
  createdAt: number;
};

type PersistedEntrySessionState = {
  schemaVersion: 1;
  sessions: Record<string, PersistedSessionRecord>;
};

type LoadedStore =
  | { corrupted: false; state: PersistedEntrySessionState }
  | { corrupted: true; state: PersistedEntrySessionState };

const EMPTY_STATE: PersistedEntrySessionState = {
  schemaVersion: 1,
  sessions: {},
};

/**
 * 文件版 owned session repository。
 * @remarks 文件路径已按 AK scope 分片；`akScopeKey` 仅用于返回应用层记录，不参与路径选择。
 */
export class FileOwnedSessionRepository implements OwnedSessionRepository {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    filePath: string;
    now?: () => number;
    onCorruptStore?: (error: unknown) => void;
    onCorruptBackup?: (backupPath: string) => void;
    onCorruptBackupFailed?: (error: unknown) => void;
    onInvalidRecord?: (sessionId: string) => void;
    diagnostics?: SessionIsolationDiagnosticsPort;
  }) {}

  async findByEntryKey(input: { akScopeKey: string; entryKey: string }): Promise<OwnedSessionRecord[]> {
    const loaded = await this.load();
    return Object.entries(loaded.state.sessions)
      .filter(([, record]) => record.entryKey === input.entryKey)
      .map(([sessionId, record]) => this.toOwnedSessionRecord(input.akScopeKey, sessionId, record));
  }

  async findBySessionId(input: { akScopeKey: string; sessionId: string }): Promise<OwnedSessionRecord | undefined> {
    const loaded = await this.load();
    const record = loaded.state.sessions[input.sessionId];
    return record ? this.toOwnedSessionRecord(input.akScopeKey, input.sessionId, record) : undefined;
  }

  async upsert(record: OwnedSessionRecord): Promise<void> {
    return this.enqueueMutation(async () => {
      const loaded = await this.load();
      if (loaded.corrupted) {
        await this.backupCorruptedStoreBestEffort();
      }
      await this.save({
        schemaVersion: 1,
        sessions: {
          ...loaded.state.sessions,
          [record.sessionId]: {
            origin: 'welink-entry-owned',
            entryKey: record.entryKey,
            controlled: record.controlled,
            permissionProfile: record.permissionProfile,
            createdAt: loaded.state.sessions[record.sessionId]?.createdAt ?? this.now(),
          },
        },
      });
    });
  }

  async deleteBySessionId(input: { akScopeKey: string; sessionId: string }): Promise<void> {
    return this.enqueueMutation(async () => {
      const loaded = await this.load();
      if (loaded.corrupted) {
        await this.backupCorruptedStoreBestEffort();
      }
      const { [input.sessionId]: _deleted, ...sessions } = loaded.state.sessions;
      await this.save({
        schemaVersion: 1,
        sessions,
      });
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.mutationQueue.then(operation, operation);
    this.mutationQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private async load(): Promise<LoadedStore> {
    try {
      const content = await readFile(this.options.filePath, 'utf8');
      return {
        corrupted: false,
        state: this.parseState(content),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          corrupted: false,
          state: this.emptyState(),
        };
      }
      this.options.onCorruptStore?.(error);
      this.options.diagnostics?.record({
        kind: 'owned_session_store_corrupt',
        severity: 'warn',
        filePath: this.options.filePath,
        errorMessage: this.toErrorMessage(error),
      });
      return {
        corrupted: true,
        state: this.emptyState(),
      };
    }
  }

  private parseState(content: string): PersistedEntrySessionState {
    const parsed = JSON.parse(content) as unknown;
    if (!this.hasValidStateShape(parsed)) {
      throw new Error('invalid_entry_session_store');
    }
    return {
      schemaVersion: 1,
      sessions: this.filterValidSessions(parsed.sessions),
    };
  }

  private hasValidStateShape(value: unknown): value is PersistedEntrySessionState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const state = value as PersistedEntrySessionState;
    return !(state.schemaVersion !== 1
      || typeof state.sessions !== 'object'
      || state.sessions === null
      || Array.isArray(state.sessions));
  }

  private filterValidSessions(sessions: Record<string, unknown>): Record<string, PersistedSessionRecord> {
    const validSessions: Record<string, PersistedSessionRecord> = {};
    for (const [sessionId, record] of Object.entries(sessions)) {
      if (this.isSessionRecord(record)) {
        validSessions[sessionId] = record;
        continue;
      }
      this.options.onInvalidRecord?.(sessionId);
      this.options.diagnostics?.record({
        kind: 'owned_session_store_invalid_record',
        severity: 'warn',
        filePath: this.options.filePath,
        sessionId,
      });
    }
    return validSessions;
  }

  private isSessionRecord(value: unknown): value is PersistedSessionRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const record = value as PersistedSessionRecord;
    return record.origin === 'welink-entry-owned'
      && typeof record.entryKey === 'string'
      && typeof record.controlled === 'boolean'
      && (record.permissionProfile === 'default' || record.permissionProfile === 'dialog_only')
      && typeof record.createdAt === 'number';
  }

  private async save(state: PersistedEntrySessionState): Promise<void> {
    await mkdir(dirname(this.options.filePath), { recursive: true });
    const tempPath = `${this.options.filePath}.tmp.${process.pid}.${this.now()}.${randomUUID()}`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.options.filePath);
  }

  private async backupCorruptedStoreBestEffort(): Promise<void> {
    const backupPath = `${this.options.filePath}.corrupt.${this.now()}`;
    try {
      await copyFile(this.options.filePath, backupPath);
      this.options.onCorruptBackup?.(backupPath);
      this.options.diagnostics?.record({
        kind: 'owned_session_store_backup_created',
        severity: 'warn',
        filePath: this.options.filePath,
        backupPath,
      });
    } catch (error) {
      this.options.onCorruptBackupFailed?.(error);
      this.options.diagnostics?.record({
        kind: 'owned_session_store_backup_failed',
        severity: 'error',
        filePath: this.options.filePath,
        errorMessage: this.toErrorMessage(error),
      });
      // 损坏备份不应掩盖本次正式写入；写入失败本身会向上抛出。
    }
  }

  private toOwnedSessionRecord(
    akScopeKey: string,
    sessionId: string,
    record: PersistedSessionRecord,
  ): OwnedSessionRecord {
    return {
      akScopeKey,
      sessionId,
      entryKey: record.entryKey,
      controlled: record.controlled,
      permissionProfile: record.permissionProfile,
    };
  }

  private emptyState(): PersistedEntrySessionState {
    return {
      schemaVersion: EMPTY_STATE.schemaVersion,
      sessions: {},
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
