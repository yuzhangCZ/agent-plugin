import type {
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderCreateSessionInput,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
  ProviderFact,
  ThirdPartyAgentProvider,
} from '@wecode/bridge-runtime-sdk';
import type { OpencodeSessionGatewayAdapter } from '../../adapter/index.js';
import type { BridgeLogger } from '../AppLogger.js';
import type { BridgeEvent } from '../types.js';
import type { HostClientLike } from '../../types/index.js';
import { SubagentSessionMapper } from '../../session/SubagentSessionMapper.js';
import { getErrorMessage } from '../../utils/error.js';
import type {
  AbortSessionCommandPort,
  CloseSessionCommandPort,
  CreateSessionCommandPort,
  HostEventPort,
  PermissionReplyCommandPort,
  QuestionReplyCommandPort,
} from '../../port/session-isolation/inbound/index.js';
import type {
  ChatExecutionContextResolver,
  EventAnchorResolver,
  ExecutionSessionInvalidationPort,
  SdkChatPreprocessor,
} from './SdkChatControlPlane.js';
import type { FactSessionContext, PendingInteractionRecorderPort } from './OpenCodeProviderAdapter.types.js';
import {
  ActiveRunRegistry,
  ActiveProviderRunHandle,
  AssistantMessageStateStore,
  PartKindStore,
} from './OpenCodeProviderAdapter.run.js';
import { HostSessionRunCoordinator } from './HostSessionRunCoordinator.js';
import {
  DefaultProtocolDiagnosticPort,
  DefaultOutboundTargetResolver,
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
import {
  buildImmediateFailedRun,
  hasPlatformBusinessSessionId,
} from './OpenCodeProviderAdapter.helpers.js';
import { bindProviderPromptTerminal } from './OpenCodeProviderAdapter.prompt.js';
import { TuiOutboundRunRegistry } from './OpenCodeProviderAdapter.outbound-run.js';

type ProviderAdapterOptions = {
  rawClient: HostClientLike;
  logger: BridgeLogger;
  createSessionCommandPort: CreateSessionCommandPort;
  closeSessionCommandPort?: CloseSessionCommandPort;
  abortSessionCommandPort?: AbortSessionCommandPort;
  questionReplyCommandPort?: QuestionReplyCommandPort;
  permissionReplyCommandPort?: PermissionReplyCommandPort;
  effectiveDirectory?: string;
  opencodeSessionGatewayAdapter: OpencodeSessionGatewayAdapter;
  chatPreprocessor: SdkChatPreprocessor;
  contextResolver: ChatExecutionContextResolver;
  executionSessionInvalidationPort: ExecutionSessionInvalidationPort;
  eventAnchorResolver: EventAnchorResolver;
  subagentSessionMapper: SubagentSessionMapper;
  hostEventPort?: HostEventPort;
  pendingInteractionRecorder?: PendingInteractionRecorderPort;
  finalIdleTimeoutMs?: number;
};

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
  private readonly createSessionCommandPort: CreateSessionCommandPort;
  private readonly closeSessionCommandPort?: CloseSessionCommandPort;
  private readonly abortSessionCommandPort?: AbortSessionCommandPort;
  private readonly questionReplyCommandPort?: QuestionReplyCommandPort;
  private readonly permissionReplyCommandPort?: PermissionReplyCommandPort;
  private readonly effectiveDirectory?: string;
  private readonly chatPreprocessor: SdkChatPreprocessor;
  private readonly contextResolver: ChatExecutionContextResolver;
  private readonly executionSessionInvalidationPort: ExecutionSessionInvalidationPort;
  private readonly pendingInteractionRecorder?: PendingInteractionRecorderPort;
  private readonly finalIdleTimeoutMs?: number;

  private readonly activeRuns = new ActiveRunRegistry();
  private readonly runCoordinator: HostSessionRunCoordinator;
  private readonly partKinds = new PartKindStore();
  private readonly assistantMessageStates = new AssistantMessageStateStore();
  private readonly tuiOutboundRuns: TuiOutboundRunRegistry;

  private readonly eventCoordinator: ProviderEventCoordinator;
  private runtimeContext: ProviderRuntimeContext | null = null;

  constructor(options: ProviderAdapterOptions) {
    this.logger = options.logger;
    this.finalIdleTimeoutMs = options.finalIdleTimeoutMs;
    this.pendingInteractionRecorder = options.pendingInteractionRecorder;
    this.runCoordinator = new HostSessionRunCoordinator(this.logger);
    this.tuiOutboundRuns = new TuiOutboundRunRegistry({
      logger: this.logger,
      ...(options.finalIdleTimeoutMs !== undefined ? { finalIdleTimeoutMs: options.finalIdleTimeoutMs } : {}),
      onFinalIdleTimeout: (input) => {
        this.cleanupTuiOutboundRunState(input);
      },
      onTranslationAccepted: (input) => {
        this.recordPendingInteractions(
          input.facts,
          input.factSessionContext,
          input.hostSessionId,
        );
      },
    });
    this.rawClient = options.rawClient;
    this.opencodeSessionGatewayAdapter = options.opencodeSessionGatewayAdapter;
    this.createSessionCommandPort = options.createSessionCommandPort;
    this.closeSessionCommandPort = options.closeSessionCommandPort;
    this.abortSessionCommandPort = options.abortSessionCommandPort;
    this.questionReplyCommandPort = options.questionReplyCommandPort;
    this.permissionReplyCommandPort = options.permissionReplyCommandPort;
    this.effectiveDirectory = options.effectiveDirectory;
    this.chatPreprocessor = options.chatPreprocessor;
    this.contextResolver = options.contextResolver;
    this.executionSessionInvalidationPort = options.executionSessionInvalidationPort;

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
      .register('message.updated', new AssistantMessageEventTranslator())
      .register('message.part.delta', new MessagePartDeltaTranslator())
      .register('message.part.updated', new MessagePartUpdatedTranslator())
      .register('question.asked', new QuestionAskedTranslator(true))
      .register('permission.asked', new PermissionAskedTranslator())
      .register('permission.replied', new PermissionRepliedTranslator())
      .register('session.error', new SessionErrorTranslator());

    this.eventCoordinator = new ProviderEventCoordinator({
      logger: this.logger,
      diagnostics: new DefaultProtocolDiagnosticPort(this.logger),
      observation: new DefaultTranslationObservationPort(this.logger),
      rawSessionLocator: new EventRawSessionLocator(),
      identityResolver: new EventSessionIdentityResolver({
        subagentSessionMapper: options.subagentSessionMapper,
      }),
      factRoutingContextAssembler: new FactRoutingContextAssembler(),
      sessionCreatedRecorder: new SessionCreatedRecorder({
        logger: this.logger,
        subagentSessionMapper: options.subagentSessionMapper,
      }),
      activeRunRegistry: this.activeRuns,
      outboundTargetResolver: new DefaultOutboundTargetResolver({
        eventAnchorResolver: options.eventAnchorResolver,
      }),
      assistantMessageState: this.assistantMessageStates,
      partKindState: this.partKinds,
      tuiOutboundRunRegistry: this.tuiOutboundRuns,
      activeRunTranslatorRegistry,
      outboundTranslatorRegistry,
      ...(options.hostEventPort ? { sessionIsolationHostEventPort: options.hostEventPort } : {}),
      ...(options.pendingInteractionRecorder ? { pendingInteractionRecorder: options.pendingInteractionRecorder } : {}),
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
    const result = await this.createSessionCommandPort.execute({
      ...(input.title ? { title: input.title } : {}),
      ...(input.assistantId ? { assistantId: input.assistantId } : {}),
      ...(this.effectiveDirectory ? { directory: this.effectiveDirectory } : {}),
      ...(input.extParameters !== undefined ? { extParameters: input.extParameters } : {}),
    });
    this.logger.info('runtime_sdk.provider.createSession.session_isolation_resolved', {
      resultKind: result.kind,
      toolSessionId: result.toolSessionId,
      hasExtParameters: input.extParameters !== undefined,
      hasPlatformBusinessSessionId: hasPlatformBusinessSessionId(input.extParameters),
    });
    return {
      toolSessionId: result.toolSessionId,
      ...(input.title ? { title: input.title } : {}),
    };
  }

  async runMessage(input: ProviderRunMessageInput): Promise<ProviderRun> {
    let preprocessed;
    try {
      preprocessed = await this.chatPreprocessor.preprocess(input, this.logger);
    } catch (error) {
      this.logger.warn('provider_adapter.run.immediate_failed', {
        toolSessionId: input.toolSessionId,
        runId: input.runId,
        providerOutcome: 'failed',
        mappedProviderErrorCode: error instanceof Error && error.message === 'business_entry_key_required'
          ? 'invalid_input'
          : 'provider_unavailable',
        error: getErrorMessage(error),
        failureStage: 'preprocess',
      });
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
    this.runCoordinator.enqueue(activeRun, () => bindProviderPromptTerminal({
      activeRun,
      message: input,
      context: preprocessed.context,
      ...(this.effectiveDirectory ? { effectiveDirectory: this.effectiveDirectory } : {}),
      logger: this.logger,
      gatewayAdapter: this.opencodeSessionGatewayAdapter,
      executionSessionInvalidationPort: this.executionSessionInvalidationPort,
      activeRuns: this.activeRuns,
    }));

    return {
      runId: activeRun.runId,
      facts: activeRun.queue,
      result: () => activeRun.result(),
    };
  }

  async replyQuestion(input: ProviderQuestionReplyInput): Promise<{ applied: true }> {
    if (this.questionReplyCommandPort) {
      await this.questionReplyCommandPort.execute({
        questionId: input.questionId,
        answers: input.answers,
      });
      return { applied: true };
    }

    const result = await this.opencodeSessionGatewayAdapter.replyQuestion({
      questionId: input.questionId,
      answers: input.answers,
      logger: this.logger,
    });
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'question_reply_failed');
    }
    return { applied: true };
  }

  async replyPermission(input: ProviderPermissionReplyInput): Promise<{ applied: true }> {
    if (this.permissionReplyCommandPort) {
      await this.permissionReplyCommandPort.execute({
        permissionId: input.permissionId,
        response: input.reply,
      });
      return { applied: true };
    }

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
    if (this.closeSessionCommandPort) {
      const result = await this.closeSessionCommandPort.execute({ toolSessionId: input.toolSessionId });
      if (result.kind === 'closed') {
        this.tuiOutboundRuns.closeByHostSession(result.sessionId);
      }
      this.activeRuns.abortByAnchorSession(input.toolSessionId, 'abort_session');
      return { applied: true };
    }

    const result = await this.opencodeSessionGatewayAdapter.closeSession({
      sessionId: context.opencodeSessionId,
      logger: this.logger,
    });
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'close_session_failed');
    }
    this.tuiOutboundRuns.closeByHostSession(context.opencodeSessionId);
    this.activeRuns.abortByAnchorSession(input.toolSessionId, 'abort_session');
    return { applied: true };
  }

  async abortSession(input: { toolSessionId: string }): Promise<{ applied: true }> {
    if (this.abortSessionCommandPort) {
      const result = await this.abortSessionCommandPort.execute({ toolSessionId: input.toolSessionId });
      if (result.kind !== 'aborted') {
        const error = new Error('abort_session_not_active');
        Object.assign(error, {
          errorEvidence: {
            sourceOperation: 'session.abort',
            sourceErrorCode: 'session_not_found',
          },
        });
        throw error;
      }
      this.tuiOutboundRuns.closeByHostSession(result.hostSessionId);
      this.activeRuns.abortAllByHostSession(result.hostSessionId, 'abort_session');
      return { applied: true };
    }

    const context = await this.contextResolver.resolveForControlAction(input.toolSessionId, this.logger);
    const result = await this.opencodeSessionGatewayAdapter.abortSession({
      sessionId: context.opencodeSessionId,
      logger: this.logger,
    });
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'abort_session_failed');
    }
    this.tuiOutboundRuns.closeByHostSession(context.opencodeSessionId);
    this.activeRuns.abortAllByHostSession(context.opencodeSessionId, 'abort_session');
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

  /**
   * 仅用于单测/诊断，检查宿主会话是否存在 active run 队首。
   */
  hasActiveHostSessionRunForTest(hostSessionId: string): boolean {
    return Boolean(this.activeRuns.getHeadByHostSession(hostSessionId));
  }

  private createActiveRunHandle(
    anchorSessionId: string,
    runId: string,
    hostSessionId: string,
  ): ActiveProviderRunHandle {
    return this.activeRuns.create({
      anchorSessionId,
      hostSessionId,
      runId,
      initialTrackingSessionId: hostSessionId,
      logger: this.logger,
      ...(this.finalIdleTimeoutMs !== undefined ? { finalIdleTimeoutMs: this.finalIdleTimeoutMs } : {}),
      onCleanup: (cleanup) => {
        this.cleanupActiveRunState(cleanup);
      },
    });
  }

  private cleanupActiveRunState(input: {
    anchorSessionId: string;
    hostSessionId: string;
    runId: string;
    trackingSessionIds: ReadonlySet<string>;
  }): void {
    const result = this.activeRuns.deleteIfCurrentRun(input.anchorSessionId, input.runId);
    if (!result.deleted) {
      this.activeRuns.removeHostQueueEntry(input.hostSessionId, input.runId);
      if (result.currentRunId) {
        this.logger.debug?.('provider_adapter.active_run.cleanup_skipped', {
          anchorSessionId: input.anchorSessionId,
          cleanupRunId: input.runId,
          currentRunId: result.currentRunId,
          trackingSessionIds: [...input.trackingSessionIds],
          cleanupSkippedReason: 'active_run_replaced',
        });
      }
    }

    for (const trackingSessionId of input.trackingSessionIds) {
      this.partKinds.clearSession(trackingSessionId);
      this.assistantMessageStates.clearSession(trackingSessionId);
    }
  }

  private cleanupTuiOutboundRunState(input: {
    hostSessionId: string;
    runId: string;
    trackingSessionIds: ReadonlySet<string>;
  }): void {
    // final idle 代表本轮 TUI outbound run 已 fail-closed，本地 message/part 状态必须同步丢弃。
    // 后续迟到 part 会按 orphan/unsupported 保护路径处理，避免污染下一轮 outbound run。
    for (const trackingSessionId of input.trackingSessionIds) {
      this.partKinds.clearSession(trackingSessionId);
      this.assistantMessageStates.clearSession(trackingSessionId);
    }
    this.logger.debug?.('provider_adapter.tui_outbound_run_state_cleared', {
      hostSessionId: input.hostSessionId,
      runId: input.runId,
      trackingSessionIds: [...input.trackingSessionIds],
    });
  }

  private recordPendingInteractions(
    facts: ProviderFact[],
    factSessionContext: FactSessionContext,
    hostSessionId: string,
  ): void {
    const recorder = this.pendingInteractionRecorder;
    if (!recorder) {
      return;
    }
    for (const fact of facts) {
      if (fact.type === 'question.ask') {
        recorder.record({
          kind: 'question',
          tokenId: fact.questionId,
          toolSessionId: factSessionContext.anchorSessionId,
          hostSessionId,
        });
      }
      if (fact.type === 'permission.ask') {
        recorder.record({
          kind: 'permission',
          tokenId: fact.permissionId,
          toolSessionId: factSessionContext.anchorSessionId,
          hostSessionId,
        });
      }
    }
  }

}
