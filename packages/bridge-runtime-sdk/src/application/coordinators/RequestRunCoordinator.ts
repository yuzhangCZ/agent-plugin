import type { ProviderFact, ProviderRun } from '../../domain/provider.ts';
import { FactSequenceValidator, type LifecycleProfile } from '../fact-sequence-validator.ts';
import type { SessionRuntimeRegistry } from '../ports/session-runtime-registry.ts';
import type { RunTerminalSignalProjector } from '../projectors/index.ts';
import type { EventPipeline } from './coordinator.types.ts';
import { InteractionCoordinator } from './InteractionCoordinator.ts';

const REQUEST_RUN_PROFILE: LifecycleProfile = { kind: 'request_run' };

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
      const envelopeFields = this.toToolEventEnvelopeFields(fact);

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
