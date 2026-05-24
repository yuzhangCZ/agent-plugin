import type { ProviderFact } from '../../domain/provider.ts';
import { RuntimeContractError } from '../../domain/errors.ts';
import { FactSequenceValidator, type LifecycleProfile } from '../fact-sequence-validator.ts';
import type { SessionRuntimeRegistry } from '../ports/session-runtime-registry.ts';
import type { EventPipeline } from './coordinator.types.ts';
import { InteractionCoordinator } from './InteractionCoordinator.ts';

const OUTBOUND_PROFILE: LifecycleProfile = { kind: 'outbound' };

/**
 * outbound 协调器。
 */
export class OutboundCoordinator {
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly interactionCoordinator: InteractionCoordinator;
  private readonly validator: FactSequenceValidator;
  private readonly pipeline: EventPipeline;

  constructor(
    sessionRegistry: SessionRuntimeRegistry,
    interactionCoordinator: InteractionCoordinator,
    validator: FactSequenceValidator,
    pipeline: EventPipeline,
  ) {
    this.sessionRegistry = sessionRegistry;
    this.interactionCoordinator = interactionCoordinator;
    this.validator = validator;
    this.pipeline = pipeline;
  }

  async emitOutbound(input: {
    toolSessionId: string;
    messageId: string;
    facts: AsyncIterable<ProviderFact>;
  }): Promise<{ applied: true }> {
    const acquired = this.sessionRegistry.acquireActiveOutbound(input.toolSessionId, input.messageId);
    if (!acquired.ok) {
      throw new RuntimeContractError('outbound_already_active', 'toolSessionId already has an active outbound', {
        toolSessionId: input.toolSessionId,
        messageId: input.messageId,
      });
    }

    const state = this.validator.createState();
    try {
      for await (const fact of input.facts) {
        this.pipeline.observation.factReceived(input.toolSessionId, fact, OUTBOUND_PROFILE.kind);
        const sessionLifecycle = this.sessionRegistry.get(input.toolSessionId)?.lifecycle ?? 'active';
        const validation = this.validator.consume(input.toolSessionId, fact, state, OUTBOUND_PROFILE, sessionLifecycle);
        this.interactionCoordinator.registerFromFact(input.toolSessionId, fact);
        const envelopeFields = this.toToolEventEnvelopeFields(fact);

        for (const derivedEvent of validation.derivedEvents) {
          this.pipeline.observation.derivedEventProjected(
            input.toolSessionId,
            fact.type,
            derivedEvent,
            OUTBOUND_PROFILE.kind,
          );
          const uplink = this.pipeline.eventProjector.project(input.toolSessionId, derivedEvent, envelopeFields);
          this.pipeline.observation.uplinkEmitted(uplink);
          await this.pipeline.sink.send(uplink);
        }

        if (!validation.projectFact) {
          continue;
        }

        for (const event of this.pipeline.factProjector.project(fact)) {
          const uplink = this.pipeline.eventProjector.project(input.toolSessionId, event, envelopeFields);
          this.pipeline.observation.uplinkProjected(input.toolSessionId, fact.type, uplink.type, OUTBOUND_PROFILE.kind);
          this.pipeline.observation.uplinkEmitted(uplink);
          await this.pipeline.sink.send(uplink);
        }
      }
      return { applied: true };
    } finally {
      this.sessionRegistry.releaseActiveOutbound(input.toolSessionId, input.messageId);
    }
  }

  private toToolEventEnvelopeFields(
    fact: ProviderFact,
  ): { subagentSessionId?: string; subagentName?: string } | undefined {
    if (!fact.subagentSessionId && !fact.subagentName) {
      return undefined;
    }

    return {
      ...(fact.subagentSessionId ? { subagentSessionId: fact.subagentSessionId } : {}),
      ...(fact.subagentName ? { subagentName: fact.subagentName } : {}),
    };
  }
}
