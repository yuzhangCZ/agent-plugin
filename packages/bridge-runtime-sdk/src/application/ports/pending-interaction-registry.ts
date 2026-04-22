/**
 * 挂起交互类型。
 */
export type PendingInteractionKind = 'question' | 'permission';

/**
 * 挂起交互注册输入。
 */
export interface PendingInteractionRegistryRegisterInput {
  sessionId: string;
  kind: PendingInteractionKind;
  interactionId: string;
  toolCallId?: string;
}

/**
 * 挂起交互消费输入。
 */
export interface PendingInteractionRegistryConsumeInput {
  sessionId: string;
  kind: PendingInteractionKind;
  interactionId: string;
}

/**
 * 挂起交互注册成功结果。
 */
export interface PendingInteractionRegistryRegisterOk {
  ok: true;
}

/**
 * 挂起交互注册失败结果。
 */
export interface PendingInteractionRegistryRegisterConflict {
  ok: false;
  reason: 'occupied' | 'duplicate';
}

/**
 * 挂起交互注册结果。
 */
export type PendingInteractionRegistryRegisterResult =
  | PendingInteractionRegistryRegisterOk
  | PendingInteractionRegistryRegisterConflict;

/**
 * 挂起交互消费成功结果。
 */
export interface PendingInteractionRegistryConsumeOk {
  ok: true;
}

/**
 * 挂起交互消费失败结果。
 */
export interface PendingInteractionRegistryConsumeConflict {
  ok: false;
  reason: 'missing' | 'kind_mismatch' | 'interaction_mismatch';
}

/**
 * 挂起交互消费结果。
 */
export type PendingInteractionRegistryConsumeResult =
  | PendingInteractionRegistryConsumeOk
  | PendingInteractionRegistryConsumeConflict;

/**
 * 挂起交互注册端口。
 */
export interface PendingInteractionRegistry {
  register(input: PendingInteractionRegistryRegisterInput): PendingInteractionRegistryRegisterResult;
  consume(input: PendingInteractionRegistryConsumeInput): PendingInteractionRegistryConsumeResult;
}
