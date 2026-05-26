import type {
  ProviderError,
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderCreateSessionInput,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
  ProviderTerminalResult,
  ThirdPartyAgentProvider,
} from '../../../../../packages/bridge-runtime-sdk/src/index.ts';
import type { OpencodeSessionGatewayAdapter } from '../../adapter/index.js';
import type { PromptSessionTerminal } from '../../port/SessionScopedActionGatewayPort.js';
import type { BridgeLogger } from '../AppLogger.js';
import type { BridgeEvent } from '../types.js';
import type { HostClientLike } from '../../types/index.js';
import { CreateSessionRequestNormalizer } from '../../usecase/CreateSessionRequestNormalizer.js';
import { SubagentSessionMapper } from '../../session/SubagentSessionMapper.js';
import { getErrorMessage } from '../../utils/error.js';
import type { CreateSessionUseCase } from '../../usecase/CreateSessionUseCase.js';
import type {
  CloseSessionCommandPort,
  CreateSessionCommandPort,
} from '../../port/session-isolation/inbound/index.js';
import type {
  ChatExecutionContext,
  ChatExecutionContextResolver,
  CreatedSessionBindingPort,
  EventAnchorResolver,
  ExecutionSessionInvalidationPort,
  SdkChatPreprocessor,
} from './SdkChatControlPlane.js';
import {
  ActiveRunRegistry,
  ActiveProviderRunHandle,
  AssistantMessageStateStore,
  PartKindStore,
} from './OpenCodeProviderAdapter.run.js';
import {
  DefaultProtocolDiagnosticPort,
  EventRawSessionLocator,
  EventSessionIdentityResolver,
  FactRoutingContextAssembler,
  ProviderEventCoordinator,
  SessionCreatedRecorder,
  DefaultTranslationObservationPort,
} from './OpenCodeProviderAdapter.routing.js';
import {
  AssistantMessageEventTranslator,
  EventTranslatorRegistry,
  MessagePartDeltaTranslator,
  MessagePartUpdatedTranslator,
  PermissionAskedTranslator,
  PermissionRepliedTranslator,
  QuestionAskedTranslator,
  SessionErrorTranslator,
  SessionUpdatedTranslator,
} from './OpenCodeProviderAdapter.translation.js';

type ProviderAdapterOptions = {
  rawClient: HostClientLike;
  logger: BridgeLogger;
  createSessionUseCase: CreateSessionUseCase;
  createSessionCommandPort?: CreateSessionCommandPort;
  closeSessionCommandPort?: CloseSessionCommandPort;
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

function fromFacts<T>(facts: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const fact of facts) {
        yield fact;
      }
    },
  };
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
 * OpenCode provider adapter。
 * @remarks
 * 插件侧 facade：create_session / run / reply / close 等 provider SPI 由它统一承接，
 * 具体事件编排与 raw event -> fact 翻译交由内部 coordinator 和 translators 完成。
 */
export class OpenCodeProviderAdapter implements ThirdPartyAgentProvider {
  private readonly logger: BridgeLogger;
  private readonly rawClient: HostClientLike;
  private readonly opencodeSessionGatewayAdapter: OpencodeSessionGatewayAdapter;
  private readonly createSessionUseCase: CreateSessionUseCase;
  private readonly createSessionCommandPort?: CreateSessionCommandPort;
  private readonly closeSessionCommandPort?: CloseSessionCommandPort;
  private readonly effectiveDirectory?: string;
  private readonly directoryMappingEnabled: boolean;
  private readonly createSessionRequestNormalizer = new CreateSessionRequestNormalizer();
  private readonly chatPreprocessor: SdkChatPreprocessor;
  private readonly contextResolver: ChatExecutionContextResolver;
  private readonly executionSessionInvalidationPort: ExecutionSessionInvalidationPort;
  private readonly createdSessionBindingPort: CreatedSessionBindingPort;

  private readonly activeRuns = new ActiveRunRegistry();
  private readonly partKinds = new PartKindStore();
  private readonly assistantMessageStates = new AssistantMessageStateStore();

  private readonly eventCoordinator: ProviderEventCoordinator;
  private runtimeContext: ProviderRuntimeContext | null = null;

  constructor(options: ProviderAdapterOptions) {
    this.logger = options.logger;
    this.rawClient = options.rawClient;
    this.opencodeSessionGatewayAdapter = options.opencodeSessionGatewayAdapter;
    this.createSessionUseCase = options.createSessionUseCase;
    this.createSessionCommandPort = options.createSessionCommandPort;
    this.closeSessionCommandPort = options.closeSessionCommandPort;
    this.effectiveDirectory = options.effectiveDirectory;
    this.directoryMappingEnabled = options.directoryMappingEnabled;
    this.chatPreprocessor = options.chatPreprocessor;
    this.contextResolver = options.contextResolver;
    this.executionSessionInvalidationPort = options.executionSessionInvalidationPort;
    this.createdSessionBindingPort = options.createdSessionBindingPort;

    const activeRunTranslatorRegistry = new EventTranslatorRegistry()
      .register('message.updated', new AssistantMessageEventTranslator())
      .register('message.part.delta', new MessagePartDeltaTranslator())
      .register('message.part.updated', new MessagePartUpdatedTranslator())
      .register('question.asked', new QuestionAskedTranslator(true))
      .register('permission.asked', new PermissionAskedTranslator())
      .register('permission.replied', new PermissionRepliedTranslator())
      .register('session.error', new SessionErrorTranslator())
      .register('session.updated', new SessionUpdatedTranslator());
    const outboundTranslatorRegistry = new EventTranslatorRegistry()
      .register('session.error', new SessionErrorTranslator());

    this.eventCoordinator = new ProviderEventCoordinator({
      logger: this.logger,
      diagnostics: new DefaultProtocolDiagnosticPort(this.logger),
      observation: new DefaultTranslationObservationPort(this.logger),
      rawSessionLocator: new EventRawSessionLocator(),
      identityResolver: new EventSessionIdentityResolver({
        subagentSessionMapper: options.subagentSessionMapper,
        eventAnchorResolver: options.eventAnchorResolver,
      }),
      factRoutingContextAssembler: new FactRoutingContextAssembler(),
      sessionCreatedRecorder: new SessionCreatedRecorder({
        subagentSessionMapper: options.subagentSessionMapper,
      }),
      activeRunRegistry: this.activeRuns,
      assistantMessageState: this.assistantMessageStates,
      partKindState: this.partKinds,
      activeRunTranslatorRegistry,
      outboundTranslatorRegistry,
      getRuntimeContext: () => this.runtimeContext,
    });
  }

  async initialize(context: ProviderRuntimeContext): Promise<void> {
    this.runtimeContext = context;
  }

  async health(_input: ProviderHealthInput): Promise<ProviderHealthResult> {
    const health = await this.rawClient.global?.health?.();
    return { online: Boolean(health?.healthy) };
  }

  async createSession(input: ProviderCreateSessionInput): Promise<{ toolSessionId: string; title?: string }> {
    if (this.createSessionCommandPort) {
      const normalized = this.createSessionRequestNormalizer.fromChatContext({
        assistantId: input.assistantId,
      });
      const prepared = await this.createSessionUseCase.resolveCreateSession({
        ...normalized,
        title: input.title,
        effectiveDirectory: this.effectiveDirectory,
        directoryMappingEnabled: this.directoryMappingEnabled,
      });
      const result = await this.createSessionCommandPort.execute({
        welinkSessionId: input.welinkSessionId ?? input.traceId,
        ...(input.title ? { title: input.title } : {}),
        ...(input.assistantId ? { assistantId: input.assistantId } : {}),
        ...(prepared.resolvedDirectory ? { directory: prepared.resolvedDirectory } : {}),
        ...(input.extParameters !== undefined ? { extParameters: input.extParameters } : {}),
      });
      return {
        toolSessionId: result.toolSessionId,
        ...(input.title ? { title: input.title } : {}),
      };
    }

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

    this.createdSessionBindingPort.register(result.data.sessionId, result.data.sessionId);

    return {
      toolSessionId: result.data.sessionId,
      ...(input.title ? { title: input.title } : {}),
    };
  }

  async runMessage(input: ProviderRunMessageInput): Promise<ProviderRun> {
    let preprocessed;
    try {
      preprocessed = await this.chatPreprocessor.preprocess(input, this.logger);
    } catch (error) {
      if (error instanceof Error && error.message === 'business_entry_key_required') {
        return buildImmediateFailedRun(input.toolSessionId, {
          code: 'invalid_input',
          message: 'business_entry_key_required',
        });
      }
      return buildImmediateFailedRun(input.toolSessionId, {
        code: 'provider_unavailable',
        message: getErrorMessage(error),
      });
    }
    if (preprocessed.kind === 'synthetic_run') {
      return preprocessed.run;
    }

    const activeRun = this.createActiveRunHandle(
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
      result: () => activeRun.result(),
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
    if (this.closeSessionCommandPort) {
      await this.closeSessionCommandPort.execute({ toolSessionId: input.toolSessionId });
      return { applied: true };
    }

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
    return this.eventCoordinator.handleEvent(event);
  }

  /**
   * 仅用于单测/诊断，避免直接暴露内部 store 可变入口。
   */
  hasPartKindTrackingSession(trackingSessionId: string): boolean {
    return this.partKinds.has(trackingSessionId);
  }

  /**
   * 仅用于单测/诊断，避免直接暴露内部 store 可变入口。
   */
  hasAssistantMessageTrackingSession(trackingSessionId: string): boolean {
    return this.assistantMessageStates.has(trackingSessionId);
  }

  private createActiveRunHandle(
    anchorSessionId: string,
    runId: string,
    initialTrackingSessionId: string,
  ): ActiveProviderRunHandle {
    return this.activeRuns.create({
      anchorSessionId,
      runId,
      initialTrackingSessionId,
      logger: this.logger,
      onCleanup: ({ anchorSessionId: cleanupAnchorSessionId, trackingSessionIds }) => {
        this.activeRuns.delete(cleanupAnchorSessionId);
        for (const trackingSessionId of trackingSessionIds) {
          this.partKinds.clearSession(trackingSessionId);
          this.assistantMessageStates.clearSession(trackingSessionId);
        }
      },
    });
  }

  private async bindPromptTerminal(
    activeRun: ActiveProviderRunHandle,
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
        activeRun.settlePromptTerminal({
          outcome: 'failed',
          error,
        });
        return;
      }

      this.logger.info('provider_adapter.prompt.completed', {
        toolSessionId: input.toolSessionId,
        opencodeSessionId: context.opencodeSessionId,
        runId: activeRun.runId,
        durationMs: Math.max(0, Date.now() - startedAt),
        terminalKind: promptResult.data.terminal.kind,
        ...(promptResult.data.terminal.kind === 'failed'
          ? {
              terminalErrorCode: promptResult.data.terminal.errorCode,
              terminalErrorMessage: promptResult.data.terminal.errorMessage,
              terminalErrorDetails: promptResult.data.terminal.errorDetails,
            }
          : {}),
      });
      activeRun.settlePromptTerminal(toProviderTerminalResult(promptResult.data.terminal));
    } catch (error) {
      this.executionSessionInvalidationPort.invalidateAfterFailure(input.toolSessionId, error);
      this.logger.error('provider_adapter.prompt.threw', {
        toolSessionId: input.toolSessionId,
        opencodeSessionId: context.opencodeSessionId,
        runId: activeRun.runId,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: getErrorMessage(error),
      });
      activeRun.settlePromptTerminal({
        outcome: 'failed',
        error: {
          code: 'internal_error',
          message: getErrorMessage(error),
        },
      });
    }
  }
}
