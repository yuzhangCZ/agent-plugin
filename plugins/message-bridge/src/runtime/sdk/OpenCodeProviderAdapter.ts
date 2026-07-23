/* Provider facade 汇总稳定接口与装配逻辑，拆分需独立兼容性评审。 */
import type {
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderListSlashCommandsInput,
  ProviderListSlashCommandsResult,
  ProviderCreateSessionInput,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
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
  ChatActionContext,
  ChatExecutionContextResolver,
  ChatQueuedExecution,
  ExecutionSessionInvalidationPort,
  SdkChatRunPlanner,
} from './SdkChatControlPlane.js';
import type { PendingInteractionRecorderPort } from './OpenCodeProviderAdapter.types.js';
import {
  ActiveRunRegistry,
  ActiveProviderRunHandle,
  AssistantMessageStateStore,
  PartKindStore,
} from './OpenCodeProviderAdapter.run.js';
import { HostSessionRunCoordinator } from './HostSessionRunCoordinator.js';
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
  SessionUpdatedTranslator,
} from './OpenCodeProviderAdapter.translation.js';
import {
  buildImmediateFailedRun,
  hasPlatformBusinessSessionId,
} from './OpenCodeProviderAdapter.helpers.js';
import {
  BusinessEntryContextResolver,
} from './session-isolation/index.js';
import { bindProviderCommandTerminal } from './OpenCodeProviderAdapter.command.js';
import { bindProviderPromptTerminal } from './OpenCodeProviderAdapter.prompt.js';

const LOCAL_SLASH_COMMANDS = [
  { kind: 'new', command: '/new', description: '新建会话' },
  { kind: 'sessions', command: '/sessions', description: '查看可切换会话' },
  { kind: 'session', command: '/session', description: '切换到指定会话' },
  { kind: 'models', command: '/models', description: '查看可用模型' },
  { kind: 'model', command: '/model', description: '切换后续请求使用的模型' },
] as const;

type ProviderAdapterOptions = {
  rawClient: HostClientLike;
  logger: BridgeLogger;
  createSessionCommandPort: CreateSessionCommandPort;
  closeSessionCommandPort: CloseSessionCommandPort;
  abortSessionCommandPort: AbortSessionCommandPort;
  questionReplyCommandPort?: QuestionReplyCommandPort;
  permissionReplyCommandPort?: PermissionReplyCommandPort;
  effectiveDirectory?: string;
  opencodeSessionGatewayAdapter: OpencodeSessionGatewayAdapter;
  chatRunPlanner: SdkChatRunPlanner;
  contextResolver: ChatExecutionContextResolver;
  executionSessionInvalidationPort: ExecutionSessionInvalidationPort;
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
  private readonly closeSessionCommandPort: CloseSessionCommandPort;
  private readonly abortSessionCommandPort: AbortSessionCommandPort;
  private readonly questionReplyCommandPort?: QuestionReplyCommandPort;
  private readonly permissionReplyCommandPort?: PermissionReplyCommandPort;
  private readonly effectiveDirectory?: string;
  private readonly chatRunPlanner: SdkChatRunPlanner;
  private readonly contextResolver: ChatExecutionContextResolver;
  private readonly executionSessionInvalidationPort: ExecutionSessionInvalidationPort;
  private readonly pendingInteractionRecorder?: PendingInteractionRecorderPort;
  private readonly finalIdleTimeoutMs?: number;
  private readonly businessEntryContextResolver = new BusinessEntryContextResolver();

  private readonly activeRuns = new ActiveRunRegistry();
  private readonly runCoordinator: HostSessionRunCoordinator;
  private readonly partKinds = new PartKindStore();
  private readonly assistantMessageStates = new AssistantMessageStateStore();

  private readonly eventCoordinator: ProviderEventCoordinator;

  constructor(options: ProviderAdapterOptions) {
    this.logger = options.logger;
    this.finalIdleTimeoutMs = options.finalIdleTimeoutMs;
    this.pendingInteractionRecorder = options.pendingInteractionRecorder;
    this.runCoordinator = new HostSessionRunCoordinator(this.logger);
    this.rawClient = options.rawClient;
    this.opencodeSessionGatewayAdapter = options.opencodeSessionGatewayAdapter;
    this.createSessionCommandPort = options.createSessionCommandPort;
    this.closeSessionCommandPort = options.closeSessionCommandPort;
    this.abortSessionCommandPort = options.abortSessionCommandPort;
    this.questionReplyCommandPort = options.questionReplyCommandPort;
    this.permissionReplyCommandPort = options.permissionReplyCommandPort;
    this.effectiveDirectory = options.effectiveDirectory;
    this.chatRunPlanner = options.chatRunPlanner;
    this.contextResolver = options.contextResolver;
    this.executionSessionInvalidationPort = options.executionSessionInvalidationPort;

    const activeRunTranslatorRegistry = new EventTranslatorRegistry()
      .register('message.updated', new AssistantMessageEventTranslator())
      .register('message.part.delta', new MessagePartDeltaTranslator())
      .register('message.part.updated', new MessagePartUpdatedTranslator())
      .register('question.asked', new QuestionAskedTranslator(true))
      .register('permission.asked', new PermissionAskedTranslator())
      .register('permission.replied', new PermissionRepliedTranslator())
      .register('session.updated', new SessionUpdatedTranslator());

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
      assistantMessageState: this.assistantMessageStates,
      partKindState: this.partKinds,
      activeRunTranslatorRegistry,
      ...(options.hostEventPort ? { sessionIsolationHostEventPort: options.hostEventPort } : {}),
      ...(options.pendingInteractionRecorder ? { pendingInteractionRecorder: options.pendingInteractionRecorder } : {}),
    });
  }

  async initialize(_context: ProviderRuntimeContext): Promise<void> {
    // Provider SPI 保留入口；当前无 outbound 等需要从 runtime context 读取的状态，保留空体以兼容 SDK 可选 initialize? 契约。
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

  async listSlashCommands(input: ProviderListSlashCommandsInput): Promise<ProviderListSlashCommandsResult> {
    const commands = new Map<string, { command: string; description: string }>();
    for (const command of this.resolveLocalSlashCommands(input)) {
      commands.set(command.command, {
        command: command.command,
        description: command.description,
      });
    }

    const result = await this.opencodeSessionGatewayAdapter.listCommandCatalog({
      ...(this.effectiveDirectory ? { directory: this.effectiveDirectory } : {}),
      logger: this.logger,
    });

    for (const command of result.commands) {
      const normalized = this.normalizeOpenCodeSlashCommand(command);
      if (!normalized || commands.has(normalized.command)) {
        continue;
      }
      commands.set(normalized.command, normalized);
    }

    return { slashCommands: [...commands.values()] };
  }

  async runMessage(input: ProviderRunMessageInput): Promise<ProviderRun> {
    let plan;
    try {
      plan = await this.chatRunPlanner.plan(input, this.logger);
    } catch (error) {
      this.logger.warn('provider_adapter.run.immediate_failed', {
        toolSessionId: input.toolSessionId,
        runId: input.runId,
        providerOutcome: 'failed',
        mappedProviderErrorCode: error instanceof Error && error.message === 'business_entry_key_required'
          ? 'invalid_input'
          : 'provider_unavailable',
        error: getErrorMessage(error),
        failureStage: 'plan',
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
    if (plan.kind === 'immediate_synthetic') {
      return plan.run;
    }

    return this.enqueueChatExecution(plan.context, plan.execution);
  }

  private enqueueChatExecution(
    context: ChatActionContext,
    execution: ChatQueuedExecution,
  ): ProviderRun {
    const activeRun = this.createActiveRunHandle(
      context.anchor,
      context.message.runId,
      context.sessionContext.opencodeSessionId,
    );
    if (execution.kind === 'native_command') {
      this.logger.info('provider_adapter.command.prepare_succeeded', {
        toolSessionId: context.anchor,
        opencodeSessionId: context.sessionContext.opencodeSessionId,
        runId: activeRun.runId,
        commandName: execution.commandName,
        hasAssistantId: Boolean(context.message.assistantId),
      });
      this.runCoordinator.enqueue(activeRun, () => bindProviderCommandTerminal({
        activeRun,
        context,
        commandName: execution.commandName,
        arguments: execution.arguments,
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
    this.logger.info('provider_adapter.prompt.prepare_succeeded', {
      toolSessionId: context.anchor,
      opencodeSessionId: context.sessionContext.opencodeSessionId,
      runId: activeRun.runId,
      hasAssistantId: Boolean(context.message.assistantId),
    });
    this.runCoordinator.enqueue(activeRun, () => bindProviderPromptTerminal({
      activeRun,
      context,
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

  private normalizeOpenCodeSlashCommand(input: { name: string; description?: string }): { command: string; description: string } | undefined {
    return {
      command: `/${input.name}`,
      description: input.description ?? '',
    };
  }

  private resolveLocalSlashCommands(input: ProviderListSlashCommandsInput): typeof LOCAL_SLASH_COMMANDS[number][] {
    const entryContext = this.businessEntryContextResolver.resolveOptional({
      extParameters: input.extParameters,
    });
    if (!entryContext) {
      this.logger.info('provider_adapter.slash_commands.entry_policy_unresolved', {
        traceId: input.traceId,
        hasExtParameters: input.extParameters !== undefined,
      });
      return [...LOCAL_SLASH_COMMANDS];
    }
    const allowed = new Set(entryContext.policy.allowedSlashCommands);
    return LOCAL_SLASH_COMMANDS.filter((command) => allowed.has(command.kind));
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
    await this.closeSessionCommandPort.execute({ toolSessionId: input.toolSessionId });
    this.activeRuns.abortAllByHostSession(context.opencodeSessionId, 'abort_session');

    return { applied: true };
  }

  async abortSession(input: { toolSessionId: string }): Promise<{ applied: true }> {
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

  /**
   * registry pending 状态变化通知入口。
   * @remarks 只用于恢复 active run final idle gate，不承载通用事件分发语义。
   */
  notifyRunPendingChanged(input: { hostSessionId: string; runId: string }): void {
    this.activeRuns.notifyRunPendingChanged(input);
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
      logger: this.logger,
      ...(this.finalIdleTimeoutMs !== undefined ? { finalIdleTimeoutMs: this.finalIdleTimeoutMs } : {}),
      canFinalIdleTimeout: (input) => !this.pendingInteractionRecorder?.hasPendingForRun?.(input),
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
    const result = this.activeRuns.removeHeadIfRun(input.hostSessionId, input.runId);
    const logContext = {
      anchorSessionId: input.anchorSessionId,
      hostSessionId: input.hostSessionId,
      runId: input.runId,
      status: result.status,
      remainingRunIds: result.remainingRunIds,
    };
    if (result.status === 'head_mismatch') {
      this.logger.error?.('provider_adapter.active_run.cleanup_head_mismatch', logContext);
      return;
    }
    this.logger.debug?.('provider_adapter.active_run.cleaned_up', logContext);

    for (const trackingSessionId of input.trackingSessionIds) {
      this.partKinds.clearSession(trackingSessionId);
      this.assistantMessageStates.clearSession(trackingSessionId);
    }
  }
}
