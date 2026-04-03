import type { OpencodeClient } from '../types/index.js';
import { hasError } from '../types/sdk.js';

export interface SubagentSessionMapping {
  childSessionId: string;
  parentSessionId: string;
  agentName: string;
}

export type SubagentSessionResolution =
  | {
      status: 'mapped';
      mapping: SubagentSessionMapping;
    }
  | {
      status: 'root';
    }
  | {
      status: 'lookup_failed';
      error: unknown;
    };

interface SessionCreatedRecord {
  childSessionId: string;
  parentSessionId?: string;
  agentName: string;
}

type SessionLookupClient = Pick<OpencodeClient, 'session'>;
type SessionLookupSource = SessionLookupClient | (() => SessionLookupClient | null) | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export class SubagentSessionMapper {
  private readonly childToParent = new Map<string, SubagentSessionMapping>();
  private readonly rootSessions = new Set<string>();

  constructor(private readonly source: SessionLookupSource) {}

  recordSessionCreated(record: SessionCreatedRecord): void {
    if (record.parentSessionId) {
      this.childToParent.set(record.childSessionId, {
        childSessionId: record.childSessionId,
        parentSessionId: record.parentSessionId,
        agentName: record.agentName,
      });
      this.rootSessions.delete(record.childSessionId);
      return;
    }

    this.childToParent.delete(record.childSessionId);
    this.rootSessions.add(record.childSessionId);
  }

  async resolve(sessionId: string): Promise<SubagentSessionResolution> {
    const cached = this.childToParent.get(sessionId);
    if (cached) {
      return {
        status: 'mapped',
        mapping: cached,
      };
    }

    if (this.rootSessions.has(sessionId)) {
      return { status: 'root' };
    }

    const client = this.getClient();
    if (!client) {
      return { status: 'root' };
    }

    try {
      const result = await client.session.get({ sessionID: sessionId });
      if (hasError(result)) {
        return {
          status: 'lookup_failed',
          error: result.error,
        };
      }

      const session = isRecord(result) && isRecord(result.data) ? result.data : null;
      if (!session) {
        return {
          status: 'lookup_failed',
          error: new Error('Invalid session.get response shape'),
        };
      }

      const parentSessionId = asNonEmptyString(session.parentID);
      if (!parentSessionId) {
        this.rootSessions.add(sessionId);
        return { status: 'root' };
      }

      const mapping = {
        childSessionId: sessionId,
        parentSessionId,
        agentName: asNonEmptyString(session.title) ?? 'subagent',
      } satisfies SubagentSessionMapping;
      this.childToParent.set(sessionId, mapping);
      this.rootSessions.delete(sessionId);
      return {
        status: 'mapped',
        mapping,
      };
    } catch (error) {
      return {
        status: 'lookup_failed',
        error,
      };
    }
  }

  clear(): void {
    this.childToParent.clear();
    this.rootSessions.clear();
  }

  private getClient(): SessionLookupClient | null {
    if (typeof this.source === 'function') {
      return this.source();
    }

    return this.source;
  }
}
