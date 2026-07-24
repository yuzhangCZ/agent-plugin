import type { ProviderFact, ProviderTerminalResult } from '../../domain/provider.ts';
import { RuntimeContractError } from '../../domain/errors.ts';
import { RUNTIME_FAILURE_KIND, RUNTIME_FAILURE_PHASE } from '../constants/runtime.ts';
import { GATEWAY_UPLINK_MESSAGE_TYPE } from '../constants/gateway-messages.ts';
import { classifyFact } from '../fact-semantics.ts';
import { FactSequenceValidator, type LifecycleProfile } from '../fact-sequence-validator.ts';
import type { SessionRuntimeRegistry } from '../ports/session-runtime-registry.ts';
import type { EventPipeline } from './coordinator.types.ts';
import { InteractionCoordinator } from './InteractionCoordinator.ts';
import type { ProviderFactEnricher } from '../ProviderFactEnricher.ts';
import type { RunTerminalSignalProjector } from '../projectors/index.ts';

const OUTBOUND_PROFILE: LifecycleProfile = { kind: 'outbound' };
// outbound_run 复用 request_run 的多消息生命周期校验，只在 observation 口径上区分来源。
const OUTBOUND_RUN_PROFILE: LifecycleProfile = { kind: 'outbound_run' };

/**
 * outbound 协调器。
 */
export class OutboundCoordinator {
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly interactionCoordinator: InteractionCoordinator;
  private readonly validator: FactSequenceValidator;
  private readonly pipeline: EventPipeline;
  private readonly factEnricher: ProviderFactEnricher;
  private readonly terminalProjector: RunTerminalSignalProjector;

  // eslint-disable-next-line max-params -- 应用层协调器显式接收运行时端口，避免隐藏装配依赖。
  constructor(
    sessionRegistry: SessionRuntimeRegistry,
    interactionCoordinator: InteractionCoordinator,
    validator: FactSequenceValidator,
    pipeline: EventPipeline,
    factEnricher: ProviderFactEnricher,
    terminalProjector: RunTerminalSignalProjector,
  ) {
    this.sessionRegistry = sessionRegistry;
    this.interactionCoordinator = interactionCoordinator;
    this.validator = validator;
    this.pipeline = pipeline;
    this.factEnricher = factEnricher;
    this.terminalProjector = terminalProjector;
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
      await this.consumeFacts(input.toolSessionId, input.facts, OUTBOUND_PROFILE, state);
      return { applied: true };
    } finally {
      this.sessionRegistry.releaseOutboundEmission(input.toolSessionId, input.messageId);
    }
  }

  async emitOutboundRun(input: {
    toolSessionId: string;
    runId: string;
    facts: AsyncIterable<ProviderFact>;
  }): Promise<{ applied: true }> {
    const acquired = this.sessionRegistry.acquireOutboundEmission(input.toolSessionId, input.runId);
    if (!acquired.ok) {
      throw new RuntimeContractError('outbound_already_active', 'toolSessionId already has an active outbound', {
        toolSessionId: input.toolSessionId,
        runId: input.runId,
      });
    }

    const state = this.validator.createState();
    try {
      try {
        await this.consumeFacts(input.toolSessionId, input.facts, OUTBOUND_RUN_PROFILE, state);
      } catch (error) {
        await this.emitOutboundRunFailed(input.toolSessionId, input.runId, error);
        throw error;
      }
      await this.emitOutboundRunDone(input.toolSessionId, input.runId);
      return { applied: true };
    } finally {
      this.sessionRegistry.releaseOutboundEmission(input.toolSessionId, input.runId);
    }
  }

  private async consumeFacts(
    toolSessionId: string,
    facts: AsyncIterable<ProviderFact>,
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
          this.pipeline.observation.derivedEventProjected(
            toolSessionId,
            fact.type,
            event,
            profile.kind,
          );
        } else if (classification.projectsFactEvent) {
          this.pipeline.observation.uplinkProjected(toolSessionId, fact.type, uplink.type, profile.kind);
        }
        this.pipeline.observation.uplinkEmitted(uplink);
        await this.pipeline.sink.send(uplink);
      }
    }
  }

  private async emitOutboundRunDone(toolSessionId: string, runId: string): Promise<void> {
    const result = { outcome: 'completed' } as const;
    await this.emitOutboundRunTerminal(toolSessionId, runId, result);
  }

  private async emitOutboundRunFailed(toolSessionId: string, runId: string, error: unknown): Promise<void> {
    const result: ProviderTerminalResult = {
      outcome: 'failed',
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof RuntimeContractError ? { details: { runtimeCode: error.code, ...error.details } } : {}),
      },
    };
    try {
      await this.emitOutboundRunTerminal(toolSessionId, runId, result);
    } catch {
      // 保留原始 facts 流错误；终态发送失败会由 sink/gateway 侧观测记录。
    }
  }

  private async emitOutboundRunTerminal(
    toolSessionId: string,
    runId: string,
    result: ProviderTerminalResult,
  ): Promise<void> {
    this.pipeline.observation.terminalReceived(toolSessionId, result, { runId });
    const uplink = this.terminalProjector.project({
      toolSessionId,
      result,
    });
    this.pipeline.observation.terminalProjected(toolSessionId, result, { runId });
    if (uplink.type === GATEWAY_UPLINK_MESSAGE_TYPE.toolError) {
      this.pipeline.toolErrorReporter.report({
        stage: 'outbound_terminal',
        level: 'P0',
        toolSessionId: uplink.toolSessionId,
        error: uplink.error,
        reason: uplink.reason,
      });
      return;
    }
    this.pipeline.observation.uplinkEmitted(uplink);
    await this.pipeline.sink.send(uplink);
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
