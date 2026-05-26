type PendingInteractionKind = 'question' | 'permission';

export interface PendingInteractionRecord {
  toolSessionId: string;
  hostSessionId: string;
  kind: PendingInteractionKind;
  tokenId: string;
}

/**
 * runtime 内存态 pending interaction registry。
 * @remarks question/permission reply 只允许命中已转发给 gateway 的交互 token，避免 reply 被误回放到非当前 anchor。
 */
export class RuntimePendingInteractionRegistry {
  private readonly records = new Map<string, PendingInteractionRecord>();

  register(record: PendingInteractionRecord): void {
    this.records.set(this.key(record.kind, record.tokenId), record);
  }

  record(record: PendingInteractionRecord): void {
    this.register(record);
  }

  peek(input: { kind: PendingInteractionKind; tokenId: string }): PendingInteractionRecord | undefined {
    return this.records.get(this.key(input.kind, input.tokenId));
  }

  consume(input: { kind: PendingInteractionKind; tokenId: string }): PendingInteractionRecord | undefined {
    const key = this.key(input.kind, input.tokenId);
    const record = this.records.get(key);
    if (record) {
      this.records.delete(key);
    }
    return record;
  }

  consumeIfMatch(record: PendingInteractionRecord): PendingInteractionRecord | undefined {
    const key = this.key(record.kind, record.tokenId);
    const current = this.records.get(key);
    if (!current || !this.sameRecord(current, record)) {
      return undefined;
    }
    this.records.delete(key);
    return current;
  }

  private key(kind: PendingInteractionKind, tokenId: string): string {
    return `${kind}:${tokenId}`;
  }

  private sameRecord(left: PendingInteractionRecord, right: PendingInteractionRecord): boolean {
    return left.kind === right.kind
      && left.tokenId === right.tokenId
      && left.toolSessionId === right.toolSessionId
      && left.hostSessionId === right.hostSessionId;
  }
}
