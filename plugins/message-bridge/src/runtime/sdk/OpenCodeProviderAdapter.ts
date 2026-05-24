import { randomUUID } from 'node:crypto';

import type {
  MessageDoneFact,
  MessageStartFact,
  PermissionAskFact,
  PermissionReplyFact,
  ProviderError,
  ProviderFact,
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
  ProviderTerminalResult,
  QuestionAskFact,
  SessionErrorFact,
  SessionTitleFact,
  TextDeltaFact,
  TextDoneFact,
  ThinkingDeltaFact,
  ThinkingDoneFact,
  ThirdPartyAgentProvider,
  ToolUpdateFact,
} from '../../../../../packages/bridge-runtime-sdk/src/index.ts';
import type { OpencodeSessionGatewayAdapter } from '../../adapter/index.js';
import type { PromptSessionTerminal } from '../../port/SessionScopedActionGatewayPort.js';
import type { BridgeLogger } from '../AppLogger.js';
import type { BridgeEvent } from '../types.js';
import type { HostClientLike } from '../../types/index.js';
import { CreateSessionRequestNormalizer } from '../../usecase/CreateSessionRequestNormalizer.js';
import { SubagentSessionMapper } from '../../session/SubagentSessionMapper.js';
import { getErrorMessage } from '../../utils/error.js';
import { asNumber, asRecord, asString, asTrimmedString } from '../../utils/type-guards.js';
import { AsyncIterableQueue } from './AsyncIterableQueue.js';
import type { CreateSessionUseCase } from '../../usecase/CreateSessionUseCase.js';
import type {
  ChatExecutionContext,
  ChatExecutionContextResolver,
  CreatedSessionBindingPort,
  EventAnchorResolver,
  ExecutionSessionInvalidationPort,
  SdkChatPreprocessor,
} from './SdkChatControlPlane.js';

const FACT_DRAIN_QUIET_PERIOD_MS = 40;
const FACT_DRAIN_TIMEOUT_MS = 250;

type ProviderAdapterOptions = {
  rawClient: HostClientLike;
  logger: BridgeLogger;
  createSessionUseCase: CreateSessionUseCase;
  effectiveDirectory?: string;
  directoryMappingEnabled: boolean;
  opencodeSessionGatewayAdapter: OpencodeSessionGatewayAdapter;
  chatPreprocessor: SdkChatPreprocessor;
  contextResolver: ChatExecutionContextResolver;
  executionSessionInvalidationPort: ExecutionSessionInvalidationPort;
  eventAnchorResolver: EventAnchorResolver;
  createdSessionBindingPort: CreatedSessionBindingPort;
  subagentSessionMapper: SubagentSessionMapper;
};

type AssistantMessageLifecycleState = {
  startEmitted: boolean;
  doneEmitted: boolean;
  completed: boolean;
  terminalCandidate: boolean;
};

type ActiveProviderRun = {
  runId: string;
  toolSessionId: string;
  trackingSessionIds: Set<string>;
  queue: AsyncIterableQueue<ProviderFact>;
  promptTerminalResolver: PromptTerminalResolver;
  completionResolver: RunCompletionResolver;
  factDrainTracker: FactDrainTracker;
  promptSettled: boolean;
  factsClosed: boolean;
  cleanedUp: boolean;
  terminalResult?: ProviderTerminalResult;
};

type RawEventTranslation = {
  recognized: boolean;
  toolSessionId?: string;
  envelopeMessageId?: string;
  facts: ProviderFact[];
  terminalCandidateMessageId?: string;
};

type EventRoutingContext = {
  rawToolSessionId: string;
  anchor?: string;
  subagentSessionId?: string;
  subagentName?: string;
  lookupFailedError?: unknown;
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function fromFacts(facts: ProviderFact[]): AsyncIterable<ProviderFact> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const fact of facts) {
        yield fact;
      }
    },
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function toProviderTerminalResult(terminal: PromptSessionTerminal): ProviderTerminalResult {
  switch (terminal.kind) {
    case 'completed':
      return { outcome: 'completed' };
    case 'aborted':
      return { outcome: 'aborted' };
    case 'failed':
      return {
        outcome: 'failed',
        error: {
          code: terminal.errorCode,
          message: terminal.errorMessage,
          ...(terminal.errorDetails ? { details: terminal.errorDetails } : {}),
        },
      };
  }
}

function buildDeterministicEnvelopeMessageId(prefix: string, token: string): string {
  return `${prefix}:${token}`;
}

function buildSyntheticPartId(): string {
  return `prt_${randomUUID().replaceAll('-', '')}`;
}

function buildImmediateFailedRun(
  toolSessionId: string,
  error: ProviderError,
): ProviderRun {
  return {
    runId: `immediate-${toolSessionId}`,
    facts: fromFacts([]),
    async result() {
      return {
        outcome: 'failed',
        error,
      };
    },
  };
}

/**
 * `prompt()` terminal 到 `ProviderRun.result()` 的唯一映射器。
 */
class PromptTerminalResolver {
  private readonly deferred = createDeferred<ProviderTerminalResult>();
  private settled = false;

  constructor(private readonly onSettled: (result: ProviderTerminalResult) => void) {}

  result(): Promise<ProviderTerminalResult> {
    return this.deferred.promise;
  }

  settle(result: ProviderTerminalResult): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.deferred.resolve(result);
    this.onSettled(result);
  }
}

/**
 * provider run 联合收口器。
 * @remarks
 * 插件必须自行保证：只有当 prompt terminal 已确定且 facts 已关闭时，
 * `ProviderRun.result()` 才能对外 resolve，不能把联合完成语义泄漏给 runtime。
 */
class RunCompletionResolver {
  private readonly deferred = createDeferred<ProviderTerminalResult>();
  private settled = false;

  result(): Promise<ProviderTerminalResult> {
    return this.deferred.promise;
  }

  settle(result: ProviderTerminalResult): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.deferred.resolve(result);
  }
}

/**
 * run 内 fact drain 收口器。
 * @remarks
 * 它只关心 raw event 已被解释后的“相关事件到达”和 `facts` 何时 close，
 * 不负责 terminal outcome 映射。
 */
class FactDrainTracker {
  private promptSettled = false;
  private closed = false;
  private lastRelevantEventAt = 0;
  private lastTerminalCandidateMessageId?: string;
  private quietTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      toolSessionId: string;
      runId: string;
      queue: AsyncIterableQueue<ProviderFact>;
      logger: BridgeLogger;
      onClosed: () => void;
      quietPeriodMs?: number;
      drainTimeoutMs?: number;
    },
  ) {}

  noteRelevantEvent(terminalCandidateMessageId?: string): void {
    if (this.closed) {
      return;
    }

    this.lastRelevantEventAt = Date.now();
    if (terminalCandidateMessageId) {
      this.lastTerminalCandidateMessageId = terminalCandidateMessageId;
    }

    if (!this.promptSettled || !this.lastTerminalCandidateMessageId) {
      return;
    }

    this.armQuietTimer();
  }

  onPromptSettled(): void {
    if (this.closed || this.promptSettled) {
      return;
    }

    this.promptSettled = true;
    if (this.lastTerminalCandidateMessageId) {
      this.armQuietTimer();
    }
    this.armDrainTimer();
  }

  closeFacts(reason: 'quiet_period' | 'drain_timeout'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.options.logger.debug?.('provider_adapter.fact_drain.closed', {
      toolSessionId: this.options.toolSessionId,
      runId: this.options.runId,
      reason,
      lastTerminalCandidateMessageId: this.lastTerminalCandidateMessageId,
    });
    this.options.queue.close();
    this.options.onClosed();
  }

  private armQuietTimer(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
    }
    const quietPeriodMs = this.options.quietPeriodMs ?? FACT_DRAIN_QUIET_PERIOD_MS;
    const elapsedMs = Math.max(0, Date.now() - this.lastRelevantEventAt);
    const delayMs = Math.max(0, quietPeriodMs - elapsedMs);
    this.quietTimer = setTimeout(() => {
      if (!this.promptSettled || !this.lastTerminalCandidateMessageId) {
        return;
      }
      this.closeFacts('quiet_period');
    }, delayMs);
  }

  private armDrainTimer(): void {
    if (this.drainTimer) {
      return;
    }
    this.drainTimer = setTimeout(() => {
      if (this.lastTerminalCandidateMessageId) {
        this.options.logger.warn('provider_adapter.protocol_diagnostic', {
          toolSessionId: this.options.toolSessionId,
          runId: this.options.runId,
          code: 'facts_drain_timeout_after_terminal_candidate',
          lastTerminalCandidateMessageId: this.lastTerminalCandidateMessageId,
        });
      } else {
        this.options.logger.warn('provider_adapter.protocol_diagnostic', {
          toolSessionId: this.options.toolSessionId,
          runId: this.options.runId,
          code: 'facts_drain_timeout_without_terminal_candidate',
        });
      }
      this.closeFacts('drain_timeout');
    }, this.options.drainTimeoutMs ?? FACT_DRAIN_TIMEOUT_MS);
  }
}

/**
 * OpenCode provider adapter。
 * @remarks
 * 这是插件侧唯一允许读取宿主 raw event 字段路径并把它们收敛成 SDK
 * `ProviderFact` 的边界。
 */
export class OpenCodeProviderAdapter implements ThirdPartyAgentProvider {
  private readonly logger: BridgeLogger;
  private readonly rawClient: HostClientLike;
  private readonly opencodeSessionGatewayAdapter: OpencodeSessionGatewayAdapter;
  private readonly createSessionUseCase: CreateSessionUseCase;
  private readonly effectiveDirectory?: string;
  private readonly directoryMappingEnabled: boolean;
  private readonly createSessionRequestNormalizer = new CreateSessionRequestNormalizer();
  private readonly chatPreprocessor: SdkChatPreprocessor;
  private readonly contextResolver: ChatExecutionContextResolver;
  private readonly executionSessionInvalidationPort: ExecutionSessionInvalidationPort;
  private readonly eventAnchorResolver: EventAnchorResolver;
  private readonly createdSessionBindingPort: CreatedSessionBindingPort;
  private readonly subagentSessionMapper: SubagentSessionMapper;
  private readonly activeRuns = new Map<string, ActiveProviderRun>();
  private readonly partKinds = new Map<string, Map<string, 'text' | 'reasoning'>>();
  private readonly assistantMessageStates = new Map<string, Map<string, AssistantMessageLifecycleState>>();
  private runtimeContext: ProviderRuntimeContext | null = null;

  constructor(options: ProviderAdapterOptions) {
    this.logger = options.logger;
    this.rawClient = options.rawClient;
    this.opencodeSessionGatewayAdapter = options.opencodeSessionGatewayAdapter;
    this.createSessionUseCase = options.createSessionUseCase;
    this.effectiveDirectory = options.effectiveDirectory;
    this.directoryMappingEnabled = options.directoryMappingEnabled;
    this.chatPreprocessor = options.chatPreprocessor;
    this.contextResolver = options.contextResolver;
    this.executionSessionInvalidationPort = options.executionSessionInvalidationPort;
    this.eventAnchorResolver = options.eventAnchorResolver;
    this.createdSessionBindingPort = options.createdSessionBindingPort;
    this.subagentSessionMapper = options.subagentSessionMapper;
  }

  async initialize(context: ProviderRuntimeContext): Promise<void> {
    this.runtimeContext = context;
  }

  async health(_input: ProviderHealthInput): Promise<ProviderHealthResult> {
    const health = await this.rawClient.global?.health?.();
    return { online: Boolean(health?.healthy) };
  }

  async createSession(input: { title?: string; assistantId?: string }): Promise<{ toolSessionId: string; title?: string }> {
    const normalized = this.createSessionRequestNormalizer.fromChatContext({
      assistantId: input.assistantId,
    });
    const result = await this.createSessionUseCase.execute({
      ...normalized,
      title: input.title,
      effectiveDirectory: this.effectiveDirectory,
      directoryMappingEnabled: this.directoryMappingEnabled,
    });
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'create_session_failed');
    }
    if (!result.data.sessionId) {
      throw new Error('create_session_missing_session_id');
    }

    const anchor = `anchor_${randomUUID().replaceAll('-', '')}`;
    this.createdSessionBindingPort.register(anchor, result.data.sessionId);

    return {
      toolSessionId: anchor,
      ...(input.title ? { title: input.title } : {}),
    };
  }

  async runMessage(input: ProviderRunMessageInput): Promise<ProviderRun> {
    let preprocessed;
    try {
      preprocessed = await this.chatPreprocessor.preprocess(input, this.logger);
    } catch (error) {
      return buildImmediateFailedRun(input.toolSessionId, {
        code: 'provider_unavailable',
        message: getErrorMessage(error),
      });
    }
    if (preprocessed.kind === 'synthetic_run') {
      return preprocessed.run;
    }

    const activeRun = this.createActiveRun(
      input.toolSessionId,
      input.runId,
      preprocessed.context.opencodeSessionId,
    );
    this.logger.info('provider_adapter.prompt.prepare_succeeded', {
      toolSessionId: input.toolSessionId,
      opencodeSessionId: preprocessed.context.opencodeSessionId,
      runId: activeRun.runId,
      hasAssistantId: Boolean(input.assistantId),
    });
    void this.bindPromptTerminal(activeRun, input, preprocessed.context);

    return {
      runId: activeRun.runId,
      facts: activeRun.queue,
      result: () => activeRun.completionResolver.result(),
    };
  }

  async replyQuestion(input: ProviderQuestionReplyInput): Promise<{ applied: true }> {
    const answer = input.answers[0]?.[0] ?? '';
    const result = await this.opencodeSessionGatewayAdapter.replyQuestion({
      questionId: input.questionId,
      answer,
      logger: this.logger,
    });
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'question_reply_failed');
    }
    return { applied: true };
  }

  async replyPermission(input: ProviderPermissionReplyInput): Promise<{ applied: true }> {
    const result = await this.opencodeSessionGatewayAdapter.replyPermission({
      permissionId: input.permissionId,
      response: input.reply,
      logger: this.logger,
    });
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'permission_reply_failed');
    }
    return { applied: true };
  }

  async closeSession(input: { toolSessionId: string }): Promise<{ applied: true }> {
    const context = await this.contextResolver.resolveForControlAction(input.toolSessionId, this.logger);
    const result = await this.opencodeSessionGatewayAdapter.closeSession({
      sessionId: context.opencodeSessionId,
      logger: this.logger,
    });
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'close_session_failed');
    }
    return { applied: true };
  }

  async abortSession(input: { toolSessionId: string }): Promise<{ applied: true }> {
    const context = await this.contextResolver.resolveForControlAction(input.toolSessionId, this.logger);
    const result = await this.opencodeSessionGatewayAdapter.abortSession({
      sessionId: context.opencodeSessionId,
      logger: this.logger,
    });
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'abort_session_failed');
    }
    return { applied: true };
  }

  async handleEvent(event: BridgeEvent): Promise<boolean> {
    if (event.type === 'session.created') {
      this.recordSessionCreated(event);
      return true;
    }

    const eventToolSessionId = this.extractToolSessionId(event);
    const routing = eventToolSessionId ? await this.resolveEventRouting(eventToolSessionId) : undefined;
    if (routing?.lookupFailedError) {
      this.logger.warn('provider_adapter.subagent_lookup_failed', {
        toolSessionId: routing.rawToolSessionId,
        error: getErrorMessage(routing.lookupFailedError),
      });
    }
    if (eventToolSessionId && !routing?.anchor) {
      this.logger.warn('provider_adapter.event_dropped_without_anchor', {
        toolSessionId: eventToolSessionId,
        eventType: event.type,
      });
      return false;
    }
    const hasActiveRun = routing?.anchor ? this.activeRuns.has(routing.anchor) : false;
    const hasRuntimeContext = Boolean(this.runtimeContext);

    this.logger.debug?.('provider_adapter.event.received', {
      eventType: event.type,
      translated: this.isRelevantRawEvent(event.type),
      toolSessionId: eventToolSessionId,
      resolvedToolSessionId: routing?.anchor,
      hasActiveRun,
      hasRuntimeContext,
    });

    if (routing?.anchor) {
      const activeRun = this.activeRuns.get(routing.anchor);
      if (activeRun) {
        const handled = this.routeEventToActiveRun(activeRun, event, routing);
        if (handled) {
          return true;
        }
      }
    }

    if (!this.runtimeContext) {
      return false;
    }

    const translated = this.translateEventForOutbound(event, routing);
    if (!translated.recognized || !translated.toolSessionId || translated.facts.length === 0 || !translated.envelopeMessageId) {
      return false;
    }

    await this.runtimeContext.outbound.emitOutboundMessage({
      toolSessionId: translated.toolSessionId,
      messageId: translated.envelopeMessageId,
      trigger: 'system',
      facts: fromFacts(translated.facts),
    });
    this.logger.debug?.('provider_adapter.event.routed_to_outbound', {
      eventType: event.type,
      factTypes: translated.facts.map((fact) => fact.type),
      toolSessionId: translated.toolSessionId,
      messageId: translated.envelopeMessageId,
    });
    return true;
  }

  private createActiveRun(toolSessionId: string, runId: string, opencodeSessionId: string): ActiveProviderRun {
    const queue = new AsyncIterableQueue<ProviderFact>();
    const activeRun: ActiveProviderRun = {
      runId,
      toolSessionId,
      trackingSessionIds: new Set([opencodeSessionId]),
      queue,
      promptSettled: false,
      factsClosed: false,
      cleanedUp: false,
      promptTerminalResolver: null as never,
      completionResolver: new RunCompletionResolver(),
      factDrainTracker: null as never,
    };

    activeRun.promptTerminalResolver = new PromptTerminalResolver((result) => {
      activeRun.promptSettled = true;
      activeRun.terminalResult = result;
      this.settleRunIfReady(activeRun);
      this.tryCleanupActiveRun(activeRun);
    });
    activeRun.factDrainTracker = new FactDrainTracker({
      toolSessionId,
      runId,
      queue,
      logger: this.logger,
      onClosed: () => {
        activeRun.factsClosed = true;
        this.settleRunIfReady(activeRun);
        this.tryCleanupActiveRun(activeRun);
      },
    });

    this.activeRuns.set(toolSessionId, activeRun);
    return activeRun;
  }

  private tryCleanupActiveRun(activeRun: ActiveProviderRun): void {
    if (activeRun.cleanedUp || !activeRun.promptSettled || !activeRun.factsClosed) {
      return;
    }
    activeRun.cleanedUp = true;
    this.activeRuns.delete(activeRun.toolSessionId);
    for (const sessionId of activeRun.trackingSessionIds) {
      this.partKinds.delete(sessionId);
      this.assistantMessageStates.delete(sessionId);
    }
  }

  /**
   * 只有 prompt terminal 与 facts drain 都完成后，才允许对外 resolve run.result()。
   */
  private settleRunIfReady(activeRun: ActiveProviderRun): void {
    if (!activeRun.promptSettled || !activeRun.factsClosed || !activeRun.terminalResult) {
      return;
    }
    activeRun.completionResolver.settle(activeRun.terminalResult);
  }

  private async bindPromptTerminal(
    activeRun: ActiveProviderRun,
    input: ProviderRunMessageInput,
    context: ChatExecutionContext,
  ): Promise<void> {
    const startedAt = Date.now();
    this.logger.info('provider_adapter.prompt.started', {
      toolSessionId: input.toolSessionId,
      opencodeSessionId: context.opencodeSessionId,
      runId: activeRun.runId,
      hasAssistantId: Boolean(input.assistantId),
      textLength: input.text.length,
    });

    try {
      const promptResult = await this.opencodeSessionGatewayAdapter.promptSession({
        sessionId: context.opencodeSessionId,
        text: input.text,
        agent: input.assistantId,
        modelOverride: context.modelOverride,
        logger: this.logger,
      });

      if (!promptResult.success) {
        this.executionSessionInvalidationPort.invalidateAfterFailure(input.toolSessionId, promptResult);
        this.logger.warn('provider_adapter.prompt.failed', {
          toolSessionId: input.toolSessionId,
          opencodeSessionId: context.opencodeSessionId,
          runId: activeRun.runId,
          durationMs: Math.max(0, Date.now() - startedAt),
          error: promptResult.errorMessage ?? 'provider_unavailable',
          sourceOperation: promptResult.errorEvidence?.sourceOperation,
          sourceErrorCode: promptResult.errorEvidence?.sourceErrorCode,
        });
        const sourceOperation = promptResult.errorEvidence?.sourceOperation;
        const sourceErrorCode = promptResult.errorEvidence?.sourceErrorCode;
        const error: ProviderError = sourceOperation === 'session.get' && sourceErrorCode === 'session_not_found'
          ? {
              code: 'session_not_found',
              message: promptResult.errorMessage ?? 'session_not_found',
            }
          : {
              code: 'provider_unavailable',
              message: promptResult.errorMessage ?? 'provider_unavailable',
            };
        activeRun.promptTerminalResolver.settle({
          outcome: 'failed',
          error,
        });
        activeRun.factDrainTracker.onPromptSettled();
        return;
      }

      this.logger.info('provider_adapter.prompt.completed', {
        toolSessionId: input.toolSessionId,
        opencodeSessionId: context.opencodeSessionId,
        runId: activeRun.runId,
        durationMs: Math.max(0, Date.now() - startedAt),
        terminalKind: promptResult.data.terminal.kind,
      });
      activeRun.promptTerminalResolver.settle(toProviderTerminalResult(promptResult.data.terminal));
      activeRun.factDrainTracker.onPromptSettled();
    } catch (error) {
      this.executionSessionInvalidationPort.invalidateAfterFailure(input.toolSessionId, error);
      this.logger.error('provider_adapter.prompt.threw', {
        toolSessionId: input.toolSessionId,
        opencodeSessionId: context.opencodeSessionId,
        runId: activeRun.runId,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: getErrorMessage(error),
      });
      activeRun.promptTerminalResolver.settle({
        outcome: 'failed',
        error: {
          code: 'internal_error',
          message: getErrorMessage(error),
        },
      });
      activeRun.factDrainTracker.onPromptSettled();
    }
  }

  private routeEventToActiveRun(activeRun: ActiveProviderRun, event: BridgeEvent, routing?: EventRoutingContext): boolean {
    if (routing?.rawToolSessionId) {
      activeRun.trackingSessionIds.add(routing.rawToolSessionId);
    }

    const translated = this.translateEventForActiveRun(event, routing);
    if (!translated.recognized) {
      return false;
    }

    activeRun.factDrainTracker.noteRelevantEvent(translated.terminalCandidateMessageId);
    for (const fact of translated.facts) {
      activeRun.queue.push(fact);
    }
    this.logger.debug?.('provider_adapter.event.routed_to_active_run', {
      eventType: event.type,
      factTypes: translated.facts.map((fact) => fact.type),
      toolSessionId: activeRun.toolSessionId,
      runId: activeRun.runId,
    });
    return true;
  }

  private extractToolSessionId(event: BridgeEvent): string | undefined {
    const properties = asObject(event.properties);
    switch (event.type) {
      case 'message.updated':
        return asTrimmedString(asObject(properties?.info)?.sessionID) ?? undefined;
      case 'message.part.delta':
      case 'question.asked':
      case 'permission.asked':
      case 'permission.replied':
      case 'session.error':
        return asTrimmedString(properties?.sessionID) ?? undefined;
      case 'message.part.updated':
        return asTrimmedString(asObject(properties?.part)?.sessionID) ?? undefined;
      case 'session.updated':
        return asTrimmedString(asObject(properties?.info)?.id) ?? undefined;
      default:
        return undefined;
    }
  }

  private isRelevantRawEvent(eventType: string): boolean {
    return eventType === 'message.updated'
      || eventType === 'message.part.updated'
      || eventType === 'message.part.delta'
      || eventType === 'question.asked'
      || eventType === 'permission.asked'
      || eventType === 'permission.replied'
      || eventType === 'session.error'
      || eventType === 'session.updated';
  }

  private translateEventForActiveRun(event: BridgeEvent, routing?: EventRoutingContext): RawEventTranslation {
    const properties = asObject(event.properties);
    switch (event.type) {
      case 'message.updated':
        return this.translateMessageUpdated(properties, routing);
      case 'message.part.delta':
        return this.translateMessagePartDelta(properties, routing);
      case 'message.part.updated':
        return this.translateMessagePartUpdated(properties, routing);
      case 'question.asked':
        return this.translateQuestionAsked(properties, true, routing);
      case 'permission.asked':
        return this.translatePermissionAsked(properties, routing);
      case 'permission.replied':
        return this.translatePermissionReplied(properties, routing);
      case 'session.error':
        return this.translateSessionError(properties, routing);
      case 'session.updated':
        return this.translateSessionUpdated(properties, routing);
      default:
        return { recognized: false, facts: [] };
    }
  }

  private translateEventForOutbound(event: BridgeEvent, routing?: EventRoutingContext): RawEventTranslation {
    const properties = asObject(event.properties);
    switch (event.type) {
      case 'permission.asked':
        return this.translatePermissionAsked(properties, routing);
      case 'permission.replied':
        return this.translatePermissionReplied(properties, routing);
      case 'session.error':
        return this.translateSessionError(properties, routing);
      case 'session.updated':
        return this.translateSessionUpdated(properties, routing);
      default:
        return { recognized: false, facts: [] };
    }
  }

  private rememberPartKind(toolSessionId: string, partId: string, kind: 'text' | 'reasoning'): void {
    let map = this.partKinds.get(toolSessionId);
    if (!map) {
      map = new Map();
      this.partKinds.set(toolSessionId, map);
    }
    map.set(partId, kind);
  }

  private resolvePartKind(toolSessionId: string, partId: string): 'text' | 'reasoning' {
    return this.partKinds.get(toolSessionId)?.get(partId) ?? 'text';
  }

  private getAssistantMessageState(toolSessionId: string, messageId: string): AssistantMessageLifecycleState {
    let sessionState = this.assistantMessageStates.get(toolSessionId);
    if (!sessionState) {
      sessionState = new Map();
      this.assistantMessageStates.set(toolSessionId, sessionState);
    }

    let messageState = sessionState.get(messageId);
    if (!messageState) {
      messageState = {
        startEmitted: false,
        doneEmitted: false,
        completed: false,
        terminalCandidate: false,
      };
      sessionState.set(messageId, messageState);
    }
    return messageState;
  }

  private isAssistantMessageOpen(toolSessionId: string, messageId: string): boolean {
    const state = this.assistantMessageStates.get(toolSessionId)?.get(messageId);
    return Boolean(state?.startEmitted) && !Boolean(state?.doneEmitted);
  }

  private logProtocolDiagnostic(code: string, extra: Record<string, unknown>): void {
    this.logger.warn('provider_adapter.protocol_diagnostic', {
      code,
      ...extra,
    });
  }

  private buildFactRoutingFields(
    rawToolSessionId: string,
    routing?: EventRoutingContext,
  ): Pick<MessageStartFact, 'toolSessionId' | 'subagentSessionId' | 'subagentName'> {
    if (!routing?.anchor) {
      throw new Error(`event_anchor_missing:${rawToolSessionId}`);
    }
    return {
      toolSessionId: routing.anchor,
      ...(routing?.subagentSessionId ? { subagentSessionId: routing.subagentSessionId } : {}),
      ...(routing?.subagentName ? { subagentName: routing.subagentName } : {}),
    };
  }

  private getTrackingToolSessionId(rawToolSessionId: string, routing?: EventRoutingContext): string {
    return routing?.rawToolSessionId ?? rawToolSessionId;
  }

  /**
   * 在 adapter 边界先做 fail-closed，避免非法 fact 序列继续流入 runtime validator。
   */
  private rejectFactWithoutOpenMessage(
    code: string,
    input: {
      toolSessionId: string;
      messageId: string;
      envelopeMessageId: string;
      partId?: string;
      partType?: string;
    },
  ): RawEventTranslation {
    this.logProtocolDiagnostic(code, {
      toolSessionId: input.toolSessionId,
      messageId: input.messageId,
      ...(input.partId ? { partId: input.partId } : {}),
      ...(input.partType ? { partType: input.partType } : {}),
    });
    return {
      recognized: true,
      toolSessionId: input.toolSessionId,
      envelopeMessageId: input.envelopeMessageId,
      facts: [],
    };
  }

  private translateMessageUpdated(properties: Record<string, unknown> | undefined, routing?: EventRoutingContext): RawEventTranslation {
    const info = asObject(properties?.info);
    const toolSessionId = asTrimmedString(info?.sessionID);
    const messageId = asTrimmedString(info?.id);
    if (!toolSessionId || !messageId) {
      return { recognized: true, facts: [] };
    }
    const trackingToolSessionId = this.getTrackingToolSessionId(toolSessionId, routing);
    const factRoutingFields = this.buildFactRoutingFields(toolSessionId, routing);

    const role = asTrimmedString(info?.role);
    if (role !== 'assistant') {
      return {
        recognized: true,
        toolSessionId: factRoutingFields.toolSessionId,
        envelopeMessageId: messageId,
        facts: [],
      };
    }

    const time = asObject(info?.time);
    const hasCreated = time && 'created' in time && time.created !== undefined && time.created !== null;
    const hasCompleted = time && 'completed' in time && time.completed !== undefined && time.completed !== null;
    const finish = asTrimmedString(info?.finish);
    const error = asObject(info?.error);
    const state = this.getAssistantMessageState(trackingToolSessionId, messageId);
    const facts: ProviderFact[] = [];

    if (hasCreated && !state.startEmitted) {
      state.startEmitted = true;
      facts.push({
        type: 'message.start',
        ...factRoutingFields,
        messageId,
        raw: properties,
      } satisfies MessageStartFact);
    }

    let terminalCandidateMessageId: string | undefined;
    if (hasCompleted) {
      state.completed = true;
      const isTerminalCandidate = Boolean(error) || Boolean(finish && finish !== 'tool-calls' && finish !== 'unknown');
      if (!state.startEmitted) {
        this.logProtocolDiagnostic('assistant_message_completed_without_created', {
          toolSessionId: trackingToolSessionId,
          messageId,
          finish: finish ?? null,
          hasError: Boolean(error),
        });
      } else if (!state.doneEmitted) {
        state.doneEmitted = true;
        facts.push({
          type: 'message.done',
          ...factRoutingFields,
          messageId,
          ...(finish ? { reason: finish } : {}),
          ...(asRecord(info?.tokens) ? { tokens: asRecord(info?.tokens) } : {}),
          ...(asNumber(info?.cost) !== undefined ? { cost: asNumber(info?.cost) } : {}),
          raw: properties,
        } satisfies MessageDoneFact);
      }

      if (isTerminalCandidate) {
        state.terminalCandidate = true;
        terminalCandidateMessageId = messageId;
      }
    }

    return {
      recognized: true,
      toolSessionId: factRoutingFields.toolSessionId,
      envelopeMessageId: messageId,
      facts,
      terminalCandidateMessageId,
    };
  }

  private translateMessagePartDelta(properties: Record<string, unknown> | undefined, routing?: EventRoutingContext): RawEventTranslation {
    const toolSessionId = asTrimmedString(properties?.sessionID);
    const messageId = asTrimmedString(properties?.messageID);
    const partId = asTrimmedString(properties?.partID);
    const content = asString(properties?.delta) ?? '';
    if (!toolSessionId || !messageId || !partId) {
      return { recognized: true, facts: [] };
    }
    const trackingToolSessionId = this.getTrackingToolSessionId(toolSessionId, routing);
    const factRoutingFields = this.buildFactRoutingFields(toolSessionId, routing);

    const kind = this.resolvePartKind(trackingToolSessionId, partId);
    if (!this.isAssistantMessageOpen(trackingToolSessionId, messageId)) {
      return this.rejectFactWithoutOpenMessage(
        kind === 'reasoning' ? 'thinking_delta_without_open_message' : 'text_delta_without_open_message',
        {
          toolSessionId: trackingToolSessionId,
          messageId,
          envelopeMessageId: messageId,
          partId,
          partType: kind === 'reasoning' ? 'reasoning' : 'text',
        },
      );
    }
    const fact: TextDeltaFact | ThinkingDeltaFact = kind === 'reasoning'
      ? {
          type: 'thinking.delta',
          ...factRoutingFields,
          messageId,
          partId,
          content,
          raw: properties,
        }
      : {
          type: 'text.delta',
          ...factRoutingFields,
          messageId,
          partId,
          content,
          raw: properties,
        };

    return {
      recognized: true,
      toolSessionId: factRoutingFields.toolSessionId,
      envelopeMessageId: messageId,
      facts: [fact],
    };
  }

  private translateMessagePartUpdated(properties: Record<string, unknown> | undefined, routing?: EventRoutingContext): RawEventTranslation {
    const part = asObject(properties?.part);
    const toolSessionId = asTrimmedString(part?.sessionID);
    const messageId = asTrimmedString(part?.messageID);
    const partId = asTrimmedString(part?.id);
    const partType = asTrimmedString(part?.type);
    if (!toolSessionId || !messageId || !partId || !partType) {
      return { recognized: true, facts: [] };
    }
    const trackingToolSessionId = this.getTrackingToolSessionId(toolSessionId, routing);
    const factRoutingFields = this.buildFactRoutingFields(toolSessionId, routing);

    if (partType === 'step-start' || partType === 'step-finish') {
      return {
        recognized: true,
        toolSessionId: factRoutingFields.toolSessionId,
        envelopeMessageId: messageId,
        facts: [],
      };
    }

    if (partType === 'text') {
      this.rememberPartKind(trackingToolSessionId, partId, 'text');
      if (!this.isAssistantMessageOpen(trackingToolSessionId, messageId)) {
        return this.rejectFactWithoutOpenMessage('text_done_without_open_message', {
          toolSessionId: trackingToolSessionId,
          messageId,
          envelopeMessageId: messageId,
          partId,
          partType,
        });
      }
      return {
        recognized: true,
        toolSessionId: factRoutingFields.toolSessionId,
        envelopeMessageId: messageId,
        facts: [{
          type: 'text.done',
          ...factRoutingFields,
          messageId,
          partId,
          content: asString(part?.text) ?? '',
          raw: properties,
        } satisfies TextDoneFact],
      };
    }

    if (partType === 'reasoning') {
      this.rememberPartKind(trackingToolSessionId, partId, 'reasoning');
      if (!this.isAssistantMessageOpen(trackingToolSessionId, messageId)) {
        return this.rejectFactWithoutOpenMessage('thinking_done_without_open_message', {
          toolSessionId: trackingToolSessionId,
          messageId,
          envelopeMessageId: messageId,
          partId,
          partType,
        });
      }
      return {
        recognized: true,
        toolSessionId: factRoutingFields.toolSessionId,
        envelopeMessageId: messageId,
        facts: [{
          type: 'thinking.done',
          ...factRoutingFields,
          messageId,
          partId,
          content: asString(part?.text) ?? '',
          raw: properties,
        } satisfies ThinkingDoneFact],
      };
    }

    if (partType === 'tool') {
      const tool = asObject(part?.tool);
      const state = asObject(part?.state);
      const toolCallId = asTrimmedString(tool?.callID) ?? partId;
      const toolName = asTrimmedString(tool?.name) ?? asTrimmedString(state?.title) ?? 'tool';
      const status = asTrimmedString(state?.status);
      const normalizedStatus = status === 'running' || status === 'completed' || status === 'error'
        ? status
        : 'pending';
      if (!this.isAssistantMessageOpen(trackingToolSessionId, messageId)) {
        return this.rejectFactWithoutOpenMessage('tool_update_without_open_message', {
          toolSessionId: trackingToolSessionId,
          messageId,
          envelopeMessageId: messageId,
          partId,
          partType,
        });
      }
      return {
        recognized: true,
        toolSessionId: factRoutingFields.toolSessionId,
        envelopeMessageId: messageId,
        facts: [{
          type: 'tool.update',
          ...factRoutingFields,
          messageId,
          partId,
          toolCallId,
          toolName,
          status: normalizedStatus,
          ...(asTrimmedString(state?.title) ? { title: asTrimmedString(state?.title) } : {}),
          ...(asString(state?.input) ? { input: asString(state?.input) } : {}),
          ...(asString(state?.output) ? { output: asString(state?.output) } : {}),
          ...(asString(state?.error) ? { error: asString(state?.error) } : {}),
          raw: properties,
        } satisfies ToolUpdateFact],
      };
    }

    return {
      recognized: true,
      toolSessionId: factRoutingFields.toolSessionId,
      envelopeMessageId: messageId,
      facts: [],
    };
  }

  private translateQuestionAsked(
    properties: Record<string, unknown> | undefined,
    requireOpenMessage: boolean,
    routing?: EventRoutingContext,
  ): RawEventTranslation {
    const toolSessionId = asTrimmedString(properties?.sessionID);
    const questionId = asTrimmedString(properties?.id);
    const tool = asObject(properties?.tool);
    const messageId = asTrimmedString(tool?.messageID);
    const questions = Array.isArray(properties?.questions)
      ? properties.questions
      : [];
    if (!toolSessionId || !questionId || questions.length === 0) {
      return { recognized: true, facts: [] };
    }
    const trackingToolSessionId = this.getTrackingToolSessionId(toolSessionId, routing);
    const factRoutingFields = this.buildFactRoutingFields(toolSessionId, routing);

    if (!messageId) {
      this.logProtocolDiagnostic('question_ask_missing_message_id', {
        toolSessionId: trackingToolSessionId,
        questionId,
      });
      return {
        recognized: true,
        toolSessionId: factRoutingFields.toolSessionId,
        envelopeMessageId: buildDeterministicEnvelopeMessageId('question', questionId),
        facts: [],
      };
    }

    if (requireOpenMessage && !this.isAssistantMessageOpen(trackingToolSessionId, messageId)) {
      this.logProtocolDiagnostic('question_ask_rejected_without_open_message', {
        toolSessionId: trackingToolSessionId,
        questionId,
        messageId,
      });
      return {
        recognized: true,
        toolSessionId: factRoutingFields.toolSessionId,
        envelopeMessageId: messageId,
        facts: [],
      };
    }

    const toolCallId = asTrimmedString(tool?.callID) ?? undefined;
    const fact: QuestionAskFact = {
      type: 'question.ask',
      ...factRoutingFields,
      messageId,
      partId: toolCallId ?? questionId,
      questionId,
      questions: questions
        .map((item) => asObject(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => ({
          question: asString(item.question) ?? '',
          ...(asTrimmedString(item.header) ? { header: asTrimmedString(item.header) } : {}),
          ...(Array.isArray(item.options)
            ? {
                options: item.options
                  .map((option) => asObject(option))
                  .filter((option): option is Record<string, unknown> => Boolean(option))
                  .map((option) => ({
                    label: asString(option.label) ?? '',
                  })),
              }
            : {}),
          ...(typeof item.multiple === 'boolean' ? { multiSelect: item.multiple } : {}),
        })),
      ...(toolCallId ? { toolCallId } : {}),
      raw: properties,
    };

    return {
      recognized: true,
      toolSessionId: factRoutingFields.toolSessionId,
      envelopeMessageId: messageId,
      facts: [fact],
    };
  }

  private translatePermissionAsked(properties: Record<string, unknown> | undefined, routing?: EventRoutingContext): RawEventTranslation {
    const toolSessionId = asTrimmedString(properties?.sessionID);
    const permissionId = asTrimmedString(properties?.id);
    if (!toolSessionId || !permissionId) {
      return { recognized: true, facts: [] };
    }
    const factRoutingFields = this.buildFactRoutingFields(toolSessionId, routing);

    const tool = asObject(properties?.tool);
    const messageId = asTrimmedString(tool?.messageID) ?? asTrimmedString(properties?.messageID) ?? undefined;
    const partId = asTrimmedString(tool?.callID) ?? buildSyntheticPartId();
    const fact: PermissionAskFact = {
      type: 'permission.ask',
      ...factRoutingFields,
      ...(messageId ? { messageId } : {}),
      partId,
      permissionId,
      ...(asTrimmedString(properties?.type) ? { permissionType: asTrimmedString(properties?.type) } : {}),
      ...(asTrimmedString(properties?.title) ? { title: asTrimmedString(properties?.title) } : {}),
      ...(asObject(properties?.metadata) ? { metadata: asObject(properties?.metadata) } : {}),
      raw: properties,
    };

    return {
      recognized: true,
      toolSessionId: factRoutingFields.toolSessionId,
      envelopeMessageId: messageId ?? buildDeterministicEnvelopeMessageId('permission', permissionId),
      facts: [fact],
    };
  }

  private translatePermissionReplied(properties: Record<string, unknown> | undefined, routing?: EventRoutingContext): RawEventTranslation {
    const toolSessionId = asTrimmedString(properties?.sessionID);
    const permissionId = asTrimmedString(properties?.requestID);
    const response = asTrimmedString(properties?.reply);
    if (!toolSessionId || !permissionId || !response) {
      return { recognized: true, facts: [] };
    }
    if (response !== 'once' && response !== 'always' && response !== 'reject') {
      return { recognized: true, facts: [] };
    }
    const factRoutingFields = this.buildFactRoutingFields(toolSessionId, routing);

    const fact: PermissionReplyFact = {
      type: 'permission.reply',
      ...factRoutingFields,
      permissionId,
      response,
      raw: properties,
    };

    return {
      recognized: true,
      toolSessionId: factRoutingFields.toolSessionId,
      envelopeMessageId: buildDeterministicEnvelopeMessageId('permission-reply', permissionId),
      facts: [fact],
    };
  }

  private translateSessionError(properties: Record<string, unknown> | undefined, routing?: EventRoutingContext): RawEventTranslation {
    const toolSessionId = asTrimmedString(properties?.sessionID);
    const errorText = asTrimmedString(properties?.error);
    if (!toolSessionId || !errorText) {
      return { recognized: true, facts: [] };
    }
    const factRoutingFields = this.buildFactRoutingFields(toolSessionId, routing);

    const fact: SessionErrorFact = {
      type: 'session.error',
      ...factRoutingFields,
      error: {
        code: 'internal_error',
        message: errorText,
      },
      raw: properties,
    };
    return {
      recognized: true,
      toolSessionId: factRoutingFields.toolSessionId,
      envelopeMessageId: buildDeterministicEnvelopeMessageId('session-error', toolSessionId),
      facts: [fact],
    };
  }

  private translateSessionUpdated(properties: Record<string, unknown> | undefined, routing?: EventRoutingContext): RawEventTranslation {
    const info = asObject(properties?.info);
    const toolSessionId = asTrimmedString(info?.id);
    const title = asTrimmedString(info?.title);
    if (!toolSessionId || !title) {
      this.logger.warn('provider_adapter.session_updated_ignored', {
        reason: !toolSessionId ? 'missing_session_id' : 'missing_title',
      });
      return { recognized: true, facts: [] };
    }
    const factRoutingFields = this.buildFactRoutingFields(toolSessionId, routing);
    const fact: SessionTitleFact = {
      type: 'session.title',
      ...factRoutingFields,
      title,
      raw: properties,
    };
    return {
      recognized: true,
      toolSessionId: factRoutingFields.toolSessionId,
      envelopeMessageId: buildDeterministicEnvelopeMessageId('session-title', toolSessionId),
      facts: [fact],
    };
  }

  private async resolveEventRouting(rawToolSessionId: string): Promise<EventRoutingContext> {
    const resolution = await this.subagentSessionMapper.resolve(rawToolSessionId);
    if (resolution.status === 'mapped') {
      const anchorResolution = this.eventAnchorResolver.resolveForEvent(resolution.mapping.parentSessionId);
      return {
        rawToolSessionId,
        anchor: anchorResolution?.anchor,
        subagentSessionId: resolution.mapping.childSessionId,
        subagentName: resolution.mapping.agentName,
      };
    }

    if (resolution.status === 'lookup_failed') {
      return {
        rawToolSessionId,
        lookupFailedError: resolution.error,
      };
    }

    const anchorResolution = this.eventAnchorResolver.resolveForEvent(rawToolSessionId);
    return {
      rawToolSessionId,
      anchor: anchorResolution?.anchor,
    };
  }

  private recordSessionCreated(event: BridgeEvent): void {
    const properties = asObject(event.properties);
    const info = asObject(properties?.info);
    const childSessionId = asTrimmedString(info?.id);
    const agentName = asTrimmedString(info?.title);
    if (!childSessionId) {
      return;
    }

    this.subagentSessionMapper.recordSessionCreated({
      childSessionId,
      parentSessionId: asTrimmedString(info?.parentID),
      ...(agentName ? { agentName } : {}),
    });
  }
}
