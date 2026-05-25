import type {
  PermissionPresentationContext,
  PermissionPresentationRegisterResult,
  PermissionPresentationRegistry,
} from '../../application/ports/permission-presentation-registry.ts';

/**
 * permission 展示上下文的默认 in-memory registry。
 */
export class InMemoryPermissionPresentationRegistry implements PermissionPresentationRegistry {
  private readonly records = new Map<string, PermissionPresentationContext>();

  register(record: PermissionPresentationContext): PermissionPresentationRegisterResult {
    const key = this.toKey(record.toolSessionId, record.permissionId);
    const existing = this.records.get(key);
    if (!existing) {
      this.records.set(key, record);
      return { ok: true, status: 'inserted' };
    }
    if (existing.partId === record.partId) {
      return { ok: true, status: 'duplicate_same_part' };
    }
    return {
      ok: false,
      reason: 'conflict_same_session',
      existing,
      current: record,
    };
  }

  get(toolSessionId: string, permissionId: string): PermissionPresentationContext | undefined {
    return this.records.get(this.toKey(toolSessionId, permissionId));
  }

  clearSession(toolSessionId: string): void {
    const prefix = `${toolSessionId}:`;
    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) {
        this.records.delete(key);
      }
    }
  }

  private toKey(toolSessionId: string, permissionId: string): string {
    return `${toolSessionId}:${permissionId}`;
  }
}
