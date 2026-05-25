export interface PermissionPresentationContext {
  toolSessionId: string;
  permissionId: string;
  partId: string;
  messageId?: string;
  permissionType?: string;
  subagentSessionId?: string;
}

export type PermissionPresentationRegisterResult =
  | { ok: true; status: 'inserted' | 'duplicate_same_part' }
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
