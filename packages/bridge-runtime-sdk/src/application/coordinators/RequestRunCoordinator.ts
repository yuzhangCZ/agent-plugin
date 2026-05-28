import type { ProviderFact, ProviderRun } from '../../domain/provider.ts';
import { RUNTIME_FAILURE_KIND, RUNTIME_FAILURE_PHASE } from '../constants/runtime.ts';
import { classifyFact } from '../fact-semantics.ts';
import { FactSequenceValidator, type LifecycleProfile } from '../fact-sequence-validator.ts';
import type { RunTerminalSignalProjector } from '../projectors/index.ts';
import type { RequestRunFailureToolErrorProjector } from '../projectors/RequestRunFailureToolErrorProjector.ts';
import type { EventPipeline } from './coordinator.types.ts';
import { InteractionCoordinator } from './InteractionCoordinator.ts';
import { RuntimeContractError } from '../../domain/errors.ts';
import type { ProviderFactEnricher } from '../ProviderFactEnricher.ts';

const REQUEST_RUN_PROFILE: LifecycleProfile = { kind: 'request_run' };

/**
 * request run 协调器。
 */
export class RequestRunCoordinator {
  private readonly interactionCoordinator: InteractionCoordinator;
  private readonly validator: FactSequenceValidator;
  private readonly pipeline: EventPipeline;
  private readonly terminalProjector: RunTerminalSignalProjector;
  private readonly requestRunFailureProjector: RequestRunFailureToolErrorProjector;
  private readonly factEnricher: ProviderFactEnricher;

  constructor(
    interactionCoordinator: InteractionCoordinator,
    validator: FactSequenceValidator,
    pipeline: EventPipeline,
    factEnricher: ProviderFactEnricher,
    terminalProjector: RunTerminalSignalProjector,
    requestRunFailureProjector: RequestRunFailureToolErrorProjector,
  ) {
    this.interactionCoordinator = interactionCoordinator;
    this.validator = validator;
    this.pipeline = pipeline;
    this.factEnricher = factEnricher;
    this.terminalProjector = terminalProjector;
    this.requestRunFailureProjector = requestRunFailureProjector;
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
      if (this.shouldProjectLifecycleFailure(factsResult.reason)) {
        const uplink = this.requestRunFailureProjector.project({
          toolSessionId: input.toolSessionId,
          welinkSessionId: input.welinkSessionId,
        });
        this.pipeline.observation.uplinkEmitted(uplink);
        await this.pipeline.sink.send(uplink);
      }
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

  private shouldProjectLifecycleFailure(error: unknown): error is RuntimeContractError {
    return error instanceof RuntimeContractError
      && (error.code === 'fact_sequence_invalid' || error.code === 'pending_interaction_conflict');
  }

  private async consumeFacts(
    facts: AsyncIterable<ProviderFact>,
    toolSessionId: string,
    profile: LifecycleProfile,
    state: ReturnType<FactSequenceValidator['createState']>,
  ): Promise<void> {
    for await (const fact of facts) {
      this.pipeline.observation.factReceived(toolSessionId, fact, profile.kind);
      const enriched = this.factEnricher.enrich(toolSessionId, fact);
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
      this.validator.consume(toolSessionId, fact, state, profile);
      this.interactionCoordinator.registerFromFact(toolSessionId, fact);
      const envelopeFields = this.toToolEventEnvelopeFields(fact);
      const events = this.pipeline.factProjector.project(enriched.fact);

      for (const event of events) {
        const uplink = this.pipeline.eventProjector.project(toolSessionId, event, envelopeFields);
        if (classification.emitsDerivedEvent) {
          this.pipeline.observation.derivedEventProjected(toolSessionId, fact.type, event, profile.kind);
        } else if (classification.projectsFactEvent) {
          this.pipeline.observation.uplinkProjected(toolSessionId, fact.type, uplink.type, profile.kind);
        }
        this.pipeline.observation.uplinkEmitted(uplink);
        await this.pipeline.sink.send(uplink);
      }
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
