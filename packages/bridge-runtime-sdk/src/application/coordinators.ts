import type { ProviderFact, ProviderRun, ProviderTerminalResult } from '../domain/provider.ts';
import { RuntimeContractError } from '../domain/errors.ts';
import type {
  FactToSkillEventProjector,
  GatewayOutboundSink,
  RunTerminalSignalProjector,
  SkillEventToGatewayMessageProjector,
} from './projectors.ts';
import { FactSequenceValidator, type LifecycleProfile } from './fact-sequence-validator.ts';
import type {
  PendingInteractionRegistry,
  SessionRuntimeRegistry,
} from './registries.ts';
import type { RuntimeTraceCollector } from './runtime-trace.ts';

const REQUEST_RUN_PROFILE: LifecycleProfile = { kind: 'request_run' };
const OUTBOUND_PROFILE: LifecycleProfile = { kind: 'outbound' };

/**
 * pending interaction 协调器。
 */
export class InteractionCoordinator {
  private readonly registry: PendingInteractionRegistry;
  private readonly trace: RuntimeTraceCollector;

  constructor(registry: PendingInteractionRegistry, trace: RuntimeTraceCollector) {
    this.registry = registry;
    this.trace = trace;
  }

  registerFromFact(fact: ProviderFact): void {
    if (fact.type === 'question.ask') {
      this.registry.register({
        toolSessionId: fact.toolSessionId,
        kind: 'question',
        messageId: fact.messageId,
        tokenId: fact.toolCallId,
      });
      this.trace.recordInteraction({
        action: 'register',
        kind: 'question',
        toolSessionId: fact.toolSessionId,
        tokenId: fact.toolCallId,
      });
      return;
    }

    if (fact.type === 'permission.ask') {
      this.registry.register({
        toolSessionId: fact.toolSessionId,
        kind: 'permission',
        messageId: fact.messageId,
        tokenId: fact.permissionId,
      });
      this.trace.recordInteraction({
        action: 'register',
        kind: 'permission',
        toolSessionId: fact.toolSessionId,
        tokenId: fact.permissionId,
      });
    }
  }

  consume(toolSessionId: string, kind: 'question' | 'permission', tokenId: string): void {
    const interaction = this.registry.consume({ toolSessionId, kind, tokenId });
    if (!interaction) {
      throw new RuntimeContractError('pending_interaction_not_found', `${kind} interaction not found`, {
        toolSessionId,
        tokenId,
      });
    }

    this.trace.recordInteraction({
      action: 'consume',
      kind,
      toolSessionId,
      tokenId,
    });
  }

  clearSession(toolSessionId: string): void {
    this.registry.clearSession(toolSessionId);
    this.trace.recordInteraction({
      action: 'clear',
      toolSessionId,
    });
  }
}

interface EventPipeline {
  sink: GatewayOutboundSink;
  factProjector: FactToSkillEventProjector;
  eventProjector: SkillEventToGatewayMessageProjector;
  trace: RuntimeTraceCollector;
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
      this.pipeline.trace.recordTerminal(input.toolSessionId, result);
      return result;
    });

    const [factsResult, terminalResult] = await Promise.allSettled([consumeFacts, waitTerminal]);
    if (factsResult.status === 'rejected') {
      throw factsResult.reason;
    }
    if (terminalResult.status === 'rejected') {
      throw terminalResult.reason;
    }

    await this.pipeline.sink.send(
      this.terminalProjector.project({
        toolSessionId: input.toolSessionId,
        welinkSessionId: input.welinkSessionId,
        result: terminalResult.value,
      }),
    );
  }

  private async consumeFacts(
    facts: AsyncIterable<ProviderFact>,
    toolSessionId: string,
    profile: LifecycleProfile,
    state: ReturnType<FactSequenceValidator['createState']>,
  ): Promise<void> {
    for await (const fact of facts) {
      this.pipeline.trace.recordFact(fact);
      const sessionLifecycle = this.sessionRegistry.get(toolSessionId)?.lifecycle ?? 'active';
      const validation = this.validator.consume(fact, state, profile, sessionLifecycle);
      this.interactionCoordinator.registerFromFact(fact);

      for (const derivedEvent of validation.derivedEvents) {
        this.pipeline.trace.recordDerivedEvent(toolSessionId, derivedEvent);
        const uplink = this.pipeline.eventProjector.project(toolSessionId, derivedEvent);
        this.pipeline.trace.recordUplink(uplink);
        await this.pipeline.sink.send(uplink);
      }

      if (!validation.projectFact) {
        continue;
      }

      for (const event of this.pipeline.factProjector.project(fact)) {
        const uplink = this.pipeline.eventProjector.project(toolSessionId, event);
        this.pipeline.trace.recordUplink(uplink);
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
        this.pipeline.trace.recordFact(fact);
        const sessionLifecycle = this.sessionRegistry.get(input.toolSessionId)?.lifecycle ?? 'active';
        const validation = this.validator.consume(fact, state, OUTBOUND_PROFILE, sessionLifecycle);
        this.interactionCoordinator.registerFromFact(fact);

        for (const derivedEvent of validation.derivedEvents) {
          this.pipeline.trace.recordDerivedEvent(input.toolSessionId, derivedEvent);
          const uplink = this.pipeline.eventProjector.project(input.toolSessionId, derivedEvent);
          this.pipeline.trace.recordUplink(uplink);
          await this.pipeline.sink.send(uplink);
        }

        if (!validation.projectFact) {
          continue;
        }

        for (const event of this.pipeline.factProjector.project(fact)) {
          const uplink = this.pipeline.eventProjector.project(input.toolSessionId, event);
          this.pipeline.trace.recordUplink(uplink);
          await this.pipeline.sink.send(uplink);
        }
      }
      return { applied: true };
    } finally {
      this.sessionRegistry.releaseActiveOutbound(input.toolSessionId, input.messageId);
    }
  }
}
