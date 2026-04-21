/**
 * 会话运行时租约作用域。
 */
export type SessionRuntimeLeaseScope = 'run' | 'outbound';

/**
 * 会话运行时注册输入。
 */
export interface SessionRuntimeRegistryAcquireInput {
  sessionId: string;
  scope: SessionRuntimeLeaseScope;
  leaseId: string;
}

/**
 * 会话运行时释放输入。
 */
export interface SessionRuntimeRegistryReleaseInput {
  sessionId: string;
  scope: SessionRuntimeLeaseScope;
  leaseId: string;
}

/**
 * 会话运行时注册成功结果。
 */
export interface SessionRuntimeRegistryAcquireOk {
  ok: true;
}

/**
 * 会话运行时注册失败结果。
 */
export interface SessionRuntimeRegistryAcquireConflict {
  ok: false;
  reason: 'missing_session' | 'occupied' | 'closed';
}

/**
 * 会话运行时注册结果。
 */
export type SessionRuntimeRegistryAcquireResult = SessionRuntimeRegistryAcquireOk | SessionRuntimeRegistryAcquireConflict;

/**
 * 会话运行时释放成功结果。
 */
export interface SessionRuntimeRegistryReleaseOk {
  ok: true;
}

/**
 * 会话运行时释放失败结果。
 */
export interface SessionRuntimeRegistryReleaseConflict {
  ok: false;
  reason: 'missing_session' | 'lease_mismatch';
}

/**
 * 会话运行时释放结果。
 */
export type SessionRuntimeRegistryReleaseResult = SessionRuntimeRegistryReleaseOk | SessionRuntimeRegistryReleaseConflict;

/**
 * 会话运行时注册端口。
 */
export interface SessionRuntimeRegistry {
  acquire(input: SessionRuntimeRegistryAcquireInput): SessionRuntimeRegistryAcquireResult;
  release(input: SessionRuntimeRegistryReleaseInput): SessionRuntimeRegistryReleaseResult;
}
