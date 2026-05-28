/**
 * 挂起交互类型。
 */
export type PendingInteractionKind = 'question' | 'permission';

/**
 * runtime 挂起交互记录。
 */
export interface PendingInteractionRecord {
  toolSessionId: string;
  kind: PendingInteractionKind;
  messageId?: string;
  tokenId: string;
}

/**
 * 跨 session 冲突详情。
 */
export interface PendingInteractionConflict {
  current: PendingInteractionRecord;
  existing: PendingInteractionRecord;
}

/**
 * 挂起交互注册结果。
 */
export type PendingInteractionRegisterResult =
  | { ok: true }
  | { ok: false; reason: 'duplicate_same_session' }
  | { ok: false; reason: 'conflict_cross_session'; conflict: PendingInteractionConflict };

/**
 * 挂起交互注册端口。
 * @remarks 这是 application coordination port，负责全局 reply token 的协调。
 */
export interface PendingInteractionRegistry {
  register(record: PendingInteractionRecord): PendingInteractionRegisterResult;
  consume(input: {
    kind: PendingInteractionRecord['kind'];
    tokenId: string;
  }): PendingInteractionRecord | undefined;
}
