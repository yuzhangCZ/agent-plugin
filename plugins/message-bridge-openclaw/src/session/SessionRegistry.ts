import type { MessageBridgeSessionRecord } from "../types.js";

export class SessionRegistry {
  private readonly byToolSessionId = new Map<string, MessageBridgeSessionRecord>();

  constructor(private readonly sessionPrefix: string) {}

  ensure(
    toolSessionId: string,
    welinkSessionId?: string,
    details?: { title?: string; createdAt?: number; updatedAt?: number },
  ): MessageBridgeSessionRecord {
    const existing = this.byToolSessionId.get(toolSessionId);
    if (existing) {
      if (welinkSessionId && !existing.welinkSessionId) {
        existing.welinkSessionId = welinkSessionId;
      }
      if (details?.title && existing.title === existing.toolSessionId) {
        existing.title = details.title;
      }
      if (details?.updatedAt) {
        existing.updatedAt = details.updatedAt;
      }
      return existing;
    }

    const now = details?.createdAt ?? Date.now();
    const record: MessageBridgeSessionRecord = {
      toolSessionId,
      sessionKey: `${this.sessionPrefix}:${toolSessionId}`,
      welinkSessionId,
      title: details?.title ?? toolSessionId,
      createdAt: now,
      updatedAt: details?.updatedAt ?? now,
    };
    this.byToolSessionId.set(toolSessionId, record);
    return record;
  }
  get(toolSessionId: string): MessageBridgeSessionRecord | undefined {
    return this.byToolSessionId.get(toolSessionId);
  }

  delete(toolSessionId: string): MessageBridgeSessionRecord | undefined {
    const existing = this.byToolSessionId.get(toolSessionId);
    this.byToolSessionId.delete(toolSessionId);
    return existing;
  }
}
