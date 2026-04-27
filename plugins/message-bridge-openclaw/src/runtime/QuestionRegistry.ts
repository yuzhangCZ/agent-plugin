export type QuestionStatus = "pending" | "resolved" | "expired";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionPrompt {
  question: string;
  header?: string;
  options?: QuestionOption[];
}

export interface QuestionRecord {
  requestId: string;
  toolSessionId: string;
  toolCallId?: string;
  welinkSessionId?: string;
  questions: QuestionPrompt[];
  status: QuestionStatus;
  expiresAt?: number;
  resolvedAt?: number;
  messageId?: string;
}

export class QuestionRegistry {
  private readonly byRequestId = new Map<string, QuestionRecord>();

  upsertPending(record: Omit<QuestionRecord, "status" | "resolvedAt"> & { status?: "pending" }): QuestionRecord {
    const next: QuestionRecord = {
      ...this.byRequestId.get(record.requestId),
      ...record,
      status: "pending",
      resolvedAt: undefined,
    };
    this.byRequestId.set(next.requestId, next);
    return next;
  }

  findPending(toolSessionId: string, toolCallId?: string): QuestionRecord[] {
    return this.findBySession(toolSessionId, toolCallId).filter((record) => record.status === "pending");
  }

  findBySession(toolSessionId: string, toolCallId?: string): QuestionRecord[] {
    const matches: QuestionRecord[] = [];
    for (const record of this.byRequestId.values()) {
      if (record.toolSessionId !== toolSessionId) {
        continue;
      }
      if (toolCallId && record.toolCallId !== toolCallId) {
        continue;
      }
      matches.push(record);
    }
    return matches;
  }

  markResolved(requestId: string, resolvedAt: number = Date.now()): QuestionRecord | undefined {
    const current = this.byRequestId.get(requestId);
    if (!current) {
      return undefined;
    }
    const next: QuestionRecord = {
      ...current,
      status: "resolved",
      resolvedAt,
    };
    this.byRequestId.set(requestId, next);
    return next;
  }

  markExpired(requestId: string): QuestionRecord | undefined {
    const current = this.byRequestId.get(requestId);
    if (!current) {
      return undefined;
    }
    const next: QuestionRecord = {
      ...current,
      status: "expired",
    };
    this.byRequestId.set(requestId, next);
    return next;
  }

  clearSession(toolSessionId: string): void {
    for (const [requestId, record] of this.byRequestId.entries()) {
      if (record.toolSessionId === toolSessionId) {
        this.byRequestId.delete(requestId);
      }
    }
  }

  clearAll(): void {
    this.byRequestId.clear();
  }
}
