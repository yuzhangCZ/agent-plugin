import type { ProviderFact, ProviderRun, ProviderTerminalResult } from '../domain/provider.ts';
import { RuntimeContractError } from '../domain/errors.ts';
import type {
  FactToSkillEventProjector,
  RunTerminalSignalProjector,
  SkillEventToGatewayMessageProjector,
} from './projectors.ts';
import { FactSequenceValidator, type LifecycleProfile } from './fact-sequence-validator.ts';
import type { OutboundSink } from './ports/outbound-sink.ts';
import type { PendingInteractionRegistry } from './ports/pending-interaction-registry.ts';
import type { SessionRuntimeRegistry } from './ports/session-runtime-registry.ts';
import type { RuntimeObservation } from './runtime-observation.ts';

const REQUEST_RUN_PROFILE: LifecycleProfile = { kind: 'request_run' };
const OUTBOUND_PROFILE: LifecycleProfile = { kind: 'outbound' };

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

interface EventPipeline {
  sink: OutboundSink;
  factProjector: FactToSkillEventProjector;
  eventProjector: SkillEventToGatewayMessageProjector;
  observation: RuntimeObservation;
}

function toToolEventEnvelopeFields(fact: ProviderFact): { subagentSessionId?: string; subagentName?: string } | undefined {
  if (!fact.subagentSessionId && !fact.subagentName) {
    return undefined;
  }

  return {
    ...(fact.subagentSessionId ? { subagentSessionId: fact.subagentSessionId } : {}),
    ...(fact.subagentName ? { subagentName: fact.subagentName } : {}),
  };
}

/**
 * request run 协调器。
 */
export class RequestRunCoordinator {
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly interactionCoordinator: InteractionCoordinator;
  private readonly validator: FactSequenceValidator;
  private readonly pipeline: EventPipeline;
  private readonly terminalProjector: RunTerminalSignalProjector;

  constructor(
    sessionRegistry: SessionRuntimeRegistry,
    interactionCoordinator: InteractionCoordinator,
    validator: FactSequenceValidator,
    pipeline: EventPipeline,
    terminalProjector: RunTerminalSignalProjector,
  ) {
    this.sessionRegistry = sessionRegistry;
    this.interactionCoordinator = interactionCoordinator;
    this.validator = validator;
    this.pipeline = pipeline;
    this.terminalProjector = terminalProjector;
  }

  async executeRun(
    input: {
      toolSessionId: string;
      welinkSessionId?: string;
      runId: string;
      run: ProviderRun;
    },
  ): Promise<void> {
    const state = this.validator.createState();
    const consumeFacts = this.consumeFacts(input.run.facts, input.toolSessionId, REQUEST_RUN_PROFILE, state);
    const waitTerminal = input.run.result().then((result) => {
      this.pipeline.observation.terminalReceived(input.toolSessionId, result, {
        welinkSessionId: input.welinkSessionId,
        runId: input.runId,
      });
      return result;
    });

    const [factsResult, terminalResult] = await Promise.allSettled([consumeFacts, waitTerminal]);
    if (factsResult.status === 'rejected') {
      throw factsResult.reason;
    }
    if (terminalResult.status === 'rejected') {
      throw terminalResult.reason;
    }
    const uplink = this.terminalProjector.project({
      toolSessionId: input.toolSessionId,
      welinkSessionId: input.welinkSessionId,
      result: terminalResult.value,
    });
    this.pipeline.observation.terminalProjected(input.toolSessionId, terminalResult.value, {
      welinkSessionId: input.welinkSessionId,
      runId: input.runId,
    });
    this.pipeline.observation.uplinkEmitted(uplink);
    await this.pipeline.sink.send(uplink);
  }

  private async consumeFacts(
    facts: AsyncIterable<ProviderFact>,
    toolSessionId: string,
    profile: LifecycleProfile,
    state: ReturnType<FactSequenceValidator['createState']>,
  ): Promise<void> {
    for await (const fact of facts) {
      this.pipeline.observation.factReceived(toolSessionId, fact, profile.kind);
      const sessionLifecycle = this.sessionRegistry.get(toolSessionId)?.lifecycle ?? 'active';
      const validation = this.validator.consume(toolSessionId, fact, state, profile, sessionLifecycle);
      this.interactionCoordinator.registerFromFact(toolSessionId, fact);
      const envelopeFields = toToolEventEnvelopeFields(fact);

      for (const derivedEvent of validation.derivedEvents) {
        this.pipeline.observation.derivedEventProjected(toolSessionId, fact.type, derivedEvent, profile.kind);
        const uplink = this.pipeline.eventProjector.project(toolSessionId, derivedEvent, envelopeFields);
        this.pipeline.observation.uplinkEmitted(uplink);
        await this.pipeline.sink.send(uplink);
      }

      if (!validation.projectFact) {
        continue;
      }

      for (const event of this.pipeline.factProjector.project(fact)) {
        const uplink = this.pipeline.eventProjector.project(toolSessionId, event, envelopeFields);
        this.pipeline.observation.uplinkProjected(toolSessionId, fact.type, uplink.type, profile.kind);
        this.pipeline.observation.uplinkEmitted(uplink);
        await this.pipeline.sink.send(uplink);
      }
    }
  }
}

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
        const envelopeFields = toToolEventEnvelopeFields(fact);

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
}
