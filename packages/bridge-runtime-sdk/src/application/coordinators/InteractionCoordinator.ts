import type { ProviderFact } from '../../domain/provider.ts';
import { RuntimeContractError } from '../../domain/errors.ts';
import type { PendingInteractionRegistry } from '../ports/pending-interaction-registry.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';

/**
 * pending interaction 协调器。
 */
export class InteractionCoordinator {
  private readonly registry: PendingInteractionRegistry;
  private readonly observation: RuntimeObservation;

  constructor(registry: PendingInteractionRegistry, observation: RuntimeObservation) {
    this.registry = registry;
    this.observation = observation;
  }

  registerFromFact(toolSessionId: string, fact: ProviderFact): void {
    if (fact.type === 'question.ask') {
      const result = this.registry.register({
        toolSessionId,
        kind: 'question',
        messageId: fact.messageId,
        tokenId: fact.questionId,
      });
      if (!result.ok) {
        if (result.reason === 'duplicate_same_session') {
          return;
        }
        this.observation.interactionConflict(
          'question',
          toolSessionId,
          fact.questionId,
          result.conflict.existing.toolSessionId,
        );
        this.registry.clearSession(toolSessionId);
        throw new RuntimeContractError(
          'pending_interaction_conflict',
          'question interaction reply target must be globally unique',
          {
            currentToolSessionId: toolSessionId,
            existingToolSessionId: result.conflict.existing.toolSessionId,
            tokenId: fact.questionId,
          },
        );
      }
      this.observation.interactionRegistered('question', toolSessionId, fact.questionId);
      return;
    }

    if (fact.type === 'permission.ask') {
      const result = this.registry.register({
        toolSessionId,
        kind: 'permission',
        messageId: fact.messageId,
        tokenId: fact.permissionId,
      });
      if (!result.ok) {
        if (result.reason === 'duplicate_same_session') {
          return;
        }
        this.observation.interactionConflict(
          'permission',
          toolSessionId,
          fact.permissionId,
          result.conflict.existing.toolSessionId,
        );
        this.registry.clearSession(toolSessionId);
        throw new RuntimeContractError(
          'pending_interaction_conflict',
          'permission interaction reply target must be globally unique',
          {
            currentToolSessionId: toolSessionId,
            existingToolSessionId: result.conflict.existing.toolSessionId,
            tokenId: fact.permissionId,
          },
        );
      }
      this.observation.interactionRegistered('permission', toolSessionId, fact.permissionId);
    }
  }

  consume(kind: 'question' | 'permission', tokenId: string): string {
    const interaction = this.registry.consume({ kind, tokenId });
    if (!interaction) {
      throw new RuntimeContractError('pending_interaction_not_found', `${kind} interaction not found`, {
        tokenId,
      });
    }

    this.observation.interactionConsumed(kind, interaction.toolSessionId, tokenId);
    return interaction.toolSessionId;
  }

  clearSession(toolSessionId: string): void {
    this.registry.clearSession(toolSessionId);
    this.observation.interactionCleared(toolSessionId);
  }
}
