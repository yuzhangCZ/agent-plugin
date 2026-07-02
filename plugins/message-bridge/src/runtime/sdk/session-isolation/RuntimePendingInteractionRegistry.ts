type PendingInteractionKind = 'question' | 'permission';

type PendingInteractionRecordBase = {
  toolSessionId: string;
  hostSessionId: string;
  kind: PendingInteractionKind;
  tokenId: string;
};

export type PendingInteractionRecord =
  | (PendingInteractionRecordBase & {
      source: 'active_run';
      runId: string;
    })
  | (PendingInteractionRecordBase & {
      source: 'outbound';
    });

type RunScopedPendingInteractionRecord = Extract<PendingInteractionRecord, { source: 'active_run' }>;

/**
 * runtime 内存态 pending interaction registry。
 * @remarks question/permission reply 只允许命中已转发给 gateway 的交互 token，避免 reply 被误回放到非当前 anchor。
 */
export class RuntimePendingInteractionRegistry {
  private readonly records = new Map<string, PendingInteractionRecord>();
  private readonly runIndexes = new Map<string, Set<string>>();

  constructor(private readonly options: {
    onRunPendingChanged?: (input: { hostSessionId: string; runId: string }) => void;
  } = {}) {}

  register(record: PendingInteractionRecord): void {
    const recordKey = this.key(record.kind, record.tokenId);
    const previous = this.records.get(recordKey);
    if (this.isRunScoped(previous)) {
      this.deleteRunIndex(previous, recordKey);
    }
    this.records.set(recordKey, record);
    if (this.isRunScoped(record)) {
      this.addRunIndex(record, recordKey);
    }
  }

  record(record: PendingInteractionRecord): void {
    this.register(record);
  }

  peek(input: { kind: PendingInteractionKind; tokenId: string }): PendingInteractionRecord | undefined {
    return this.records.get(this.key(input.kind, input.tokenId));
  }

  hasPendingForRun(input: { hostSessionId: string; runId: string }): boolean {
    return Boolean(this.runIndexes.get(this.runKey(input.hostSessionId, input.runId))?.size);
  }

  consumeIfMatch(record: PendingInteractionRecord): PendingInteractionRecord | undefined {
    const key = this.key(record.kind, record.tokenId);
    const current = this.records.get(key);
    if (!current || !this.sameRecord(current, record)) {
      return undefined;
    }
    this.records.delete(key);
    if (this.isRunScoped(current)) {
      this.deleteRunIndex(current, key);
    }
    return current;
  }

  private key(kind: PendingInteractionKind, tokenId: string): string {
    return `${kind}:${tokenId}`;
  }

  private sameRecord(left: PendingInteractionRecord, right: PendingInteractionRecord): boolean {
    if (
      left.kind !== right.kind
      || left.tokenId !== right.tokenId
      || left.toolSessionId !== right.toolSessionId
      || left.hostSessionId !== right.hostSessionId
      || left.source !== right.source
    ) {
      return false;
    }
    if (this.isRunScoped(left) && this.isRunScoped(right)) {
      return left.runId === right.runId;
    }
    return left.source === 'outbound' && right.source === 'outbound';
  }

  private addRunIndex(record: RunScopedPendingInteractionRecord, recordKey: string): void {
    const runKey = this.runKey(record.hostSessionId, record.runId);
    const index = this.runIndexes.get(runKey) ?? new Set<string>();
    const sizeBefore = index.size;
    index.add(recordKey);
    this.runIndexes.set(runKey, index);
    if (index.size !== sizeBefore) {
      this.notifyRunPendingChanged(record);
    }
  }

  private deleteRunIndex(record: RunScopedPendingInteractionRecord, recordKey: string): void {
    const runKey = this.runKey(record.hostSessionId, record.runId);
    const index = this.runIndexes.get(runKey);
    if (!index) {
      return;
    }
    const deleted = index.delete(recordKey);
    if (index.size > 0) {
      this.runIndexes.set(runKey, index);
    } else {
      this.runIndexes.delete(runKey);
    }
    if (deleted) {
      this.notifyRunPendingChanged(record);
    }
  }

  private runKey(hostSessionId: string, runId: string): string {
    return `${hostSessionId}:${runId}`;
  }

  private notifyRunPendingChanged(record: RunScopedPendingInteractionRecord): void {
    this.options.onRunPendingChanged?.({
      hostSessionId: record.hostSessionId,
      runId: record.runId,
    });
  }

  private isRunScoped(record: PendingInteractionRecord | undefined): record is RunScopedPendingInteractionRecord {
    return record?.source === 'active_run';
  }
}
