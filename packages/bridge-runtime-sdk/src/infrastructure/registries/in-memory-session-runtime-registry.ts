import type {
  SessionRuntimeRegistry,
  SessionRuntimeRegistryAcquireInput,
  SessionRuntimeRegistryAcquireResult,
  SessionRuntimeRegistryReleaseInput,
  SessionRuntimeRegistryReleaseResult,
} from '../../application/ports/session-runtime-registry.ts';

interface SessionRuntimeLeaseState {
  closed: boolean;
  leases: Map<'run' | 'outbound', string>;
}

/**
 * 内存版会话运行时注册表。
 */
export class InMemorySessionRuntimeRegistry implements SessionRuntimeRegistry {
  private readonly sessions = new Map<string, SessionRuntimeLeaseState>();

  acquire(input: SessionRuntimeRegistryAcquireInput): SessionRuntimeRegistryAcquireResult {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return { ok: false, reason: 'missing_session' };
    }

    if (session.closed) {
      return { ok: false, reason: 'closed' };
    }

    if (session.leases.has(input.scope)) {
      return { ok: false, reason: 'occupied' };
    }

    session.leases.set(input.scope, input.leaseId);
    return { ok: true };
  }

  release(input: SessionRuntimeRegistryReleaseInput): SessionRuntimeRegistryReleaseResult {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return { ok: false, reason: 'missing_session' };
    }

    const currentLease = session.leases.get(input.scope);
    if (currentLease !== input.leaseId) {
      return { ok: false, reason: 'lease_mismatch' };
    }

    session.leases.delete(input.scope);
    return { ok: true };
  }

  /**
   * 预置一个会话槽位，方便测试和未来装配。
   */
  seedSession(sessionId: string): void {
    this.sessions.set(sessionId, {
      closed: false,
      leases: new Map(),
    });
  }
}
