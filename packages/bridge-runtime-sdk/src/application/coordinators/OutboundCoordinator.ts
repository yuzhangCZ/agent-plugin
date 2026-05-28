import type { ProviderFact } from '../../domain/provider.ts';
import { RuntimeContractError } from '../../domain/errors.ts';
import { RUNTIME_FAILURE_KIND, RUNTIME_FAILURE_PHASE } from '../constants/runtime.ts';
import { classifyFact } from '../fact-semantics.ts';
import { FactSequenceValidator, type LifecycleProfile } from '../fact-sequence-validator.ts';
import type { SessionRuntimeRegistry } from '../ports/session-runtime-registry.ts';
import type { EventPipeline } from './coordinator.types.ts';
import { InteractionCoordinator } from './InteractionCoordinator.ts';
import type { ProviderFactEnricher } from '../ProviderFactEnricher.ts';

const OUTBOUND_PROFILE: LifecycleProfile = { kind: 'outbound' };

/**
 * outbound 协调器。
 */
export class OutboundCoordinator {
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly interactionCoordinator: InteractionCoordinator;
  private readonly validator: FactSequenceValidator;
  private readonly pipeline: EventPipeline;
  private readonly factEnricher: ProviderFactEnricher;

  constructor(
    sessionRegistry: SessionRuntimeRegistry,
    interactionCoordinator: InteractionCoordinator,
    validator: FactSequenceValidator,
    pipeline: EventPipeline,
    factEnricher: ProviderFactEnricher,
  ) {
    this.sessionRegistry = sessionRegistry;
    this.interactionCoordinator = interactionCoordinator;
    this.validator = validator;
    this.pipeline = pipeline;
    this.factEnricher = factEnricher;
  }

  async emitOutbound(input: {
    toolSessionId: string;
    messageId: string;
    facts: AsyncIterable<ProviderFact>;
  }): Promise<{ applied: true }> {
    const acquired = this.sessionRegistry.acquireOutboundEmission(input.toolSessionId, input.messageId);
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
          const enriched = this.factEnricher.enrich(input.toolSessionId, fact);
          if (!enriched.ok) {
            this.pipeline.observation.failureRecorded(
              RUNTIME_FAILURE_KIND.outboundValidation,
              RUNTIME_FAILURE_PHASE.runtime,
              enriched.reason,
              enriched.reason,
            );
            continue;
          }
          const classification = classifyFact(fact.type);
          this.validator.consume(input.toolSessionId, fact, state, OUTBOUND_PROFILE);
          this.interactionCoordinator.registerFromFact(input.toolSessionId, fact);
          const envelopeFields = this.toToolEventEnvelopeFields(fact);
          const events = this.pipeline.factProjector.project(enriched.fact);

        for (const event of events) {
          const uplink = this.pipeline.eventProjector.project(input.toolSessionId, event, envelopeFields);
          if (classification.emitsDerivedEvent) {
            this.pipeline.observation.derivedEventProjected(
              input.toolSessionId,
              fact.type,
              event,
              OUTBOUND_PROFILE.kind,
            );
          } else if (classification.projectsFactEvent) {
            this.pipeline.observation.uplinkProjected(input.toolSessionId, fact.type, uplink.type, OUTBOUND_PROFILE.kind);
          }
          this.pipeline.observation.uplinkEmitted(uplink);
          await this.pipeline.sink.send(uplink);
        }
      }
      return { applied: true };
    } finally {
      this.sessionRegistry.releaseOutboundEmission(input.toolSessionId, input.messageId);
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
