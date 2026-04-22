import type {
  PendingInteractionRegistry,
  PendingInteractionRegistryConsumeInput,
  PendingInteractionRegistryConsumeResult,
  PendingInteractionRegistryRegisterInput,
  PendingInteractionRegistryRegisterResult,
} from '../../application/ports/pending-interaction-registry.ts';

interface PendingInteractionState {
  kind: 'question' | 'permission';
  toolCallId?: string;
}

/**
 * 内存版挂起交互注册表。
 */
export class InMemoryPendingInteractionRegistry implements PendingInteractionRegistry {
  private readonly interactions = new Map<string, PendingInteractionState>();

  register(input: PendingInteractionRegistryRegisterInput): PendingInteractionRegistryRegisterResult {
    const key = this.getKey(input.sessionId, input.kind, input.interactionId);
    if (this.interactions.has(key)) {
      return { ok: false, reason: 'duplicate' };
    }

    this.interactions.set(key, { kind: input.kind, toolCallId: input.toolCallId });
    return { ok: true };
  }

  consume(input: PendingInteractionRegistryConsumeInput): PendingInteractionRegistryConsumeResult {
    const key = this.getKey(input.sessionId, input.kind, input.interactionId);
    const current = this.interactions.get(key);
    if (!current) {
      return { ok: false, reason: 'missing' };
    }

    if (current.kind !== input.kind) {
      return { ok: false, reason: 'kind_mismatch' };
    }

    this.interactions.delete(key);
    return { ok: true };
  }

  private getKey(sessionId: string, kind: string, interactionId: string): string {
    return `${sessionId}:${kind}:${interactionId}`;
  }
}
