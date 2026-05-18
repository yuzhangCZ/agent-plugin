export type ApprovalStatus = "pending" | "resolved" | "expired";

export interface ApprovalRecord {
  toolSessionId: string;
  permissionId: string;
  status: ApprovalStatus;
  welinkSessionId?: string;
  expiresAt?: number;
  resolvedAt?: number;
  title?: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

export class ApprovalRegistry {
  private readonly byPermissionId = new Map<string, ApprovalRecord>();

  upsertPending(record: Omit<ApprovalRecord, "status" | "resolvedAt"> & { status?: "pending" }): ApprovalRecord {
    const next: ApprovalRecord = {
      ...this.byPermissionId.get(record.permissionId),
      ...record,
      status: "pending",
      resolvedAt: undefined,
    };
    this.byPermissionId.set(next.permissionId, next);
    return next;
  }

  get(permissionId: string): ApprovalRecord | undefined {
    return this.byPermissionId.get(permissionId);
  }

  markResolved(permissionId: string, resolvedAt: number = Date.now()): ApprovalRecord | undefined {
    const current = this.byPermissionId.get(permissionId);
    if (!current) {
      return undefined;
    }
    const next: ApprovalRecord = {
      ...current,
      status: "resolved",
      resolvedAt,
    };
    this.byPermissionId.set(permissionId, next);
    return next;
  }

  markExpired(permissionId: string): ApprovalRecord | undefined {
    const current = this.byPermissionId.get(permissionId);
    if (!current) {
      return undefined;
    }
    const next: ApprovalRecord = {
      ...current,
      status: "expired",
    };
    this.byPermissionId.set(permissionId, next);
    return next;
  }

  clearSession(toolSessionId: string): void {
    for (const [permissionId, record] of this.byPermissionId.entries()) {
      if (record.toolSessionId === toolSessionId) {
        this.byPermissionId.delete(permissionId);
      }
    }
  }

  clearAll(): void {
    this.byPermissionId.clear();
  }
}
