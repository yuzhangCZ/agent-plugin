export interface PermissionPresentationContext {
  toolSessionId: string;
  permissionId: string;
  partId: string;
  messageId?: string;
  permType: string;
  subagentSessionId?: string;
}

// permission 展示上下文以 toolSessionId + permissionId 作为唯一键。
// 设计前提是同一 permission 的 partId / permType 语义稳定；重复 ask 视为同一实体的幂等重放。
export type PermissionPresentationRegisterResult =
  | { ok: true; status: 'inserted' | 'duplicate_same_permission' }
  | {
      ok: false;
      reason: 'conflict_same_session';
      existing: PermissionPresentationContext;
      current: PermissionPresentationContext;
    };

export interface PermissionPresentationRegistry {
  register(record: PermissionPresentationContext): PermissionPresentationRegisterResult;
  get(toolSessionId: string, permissionId: string): PermissionPresentationContext | undefined;
  clearSession(toolSessionId: string): void;
}
