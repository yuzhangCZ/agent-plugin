import { randomUUID } from 'crypto';
import os from 'os';
import {
  ActionResult,
  ActionFailure,
  StatusQueryPayload,
  StatusQueryResultData,
} from '../types/index.js';
import { ToolErrorClassifier } from '../error/ToolErrorClassifier.js';
import {
  TOOL_ERROR_REASON,
  UPSTREAM_MESSAGE_TYPE,
  type ToolErrorReason,
  validateGatewayUplinkBusinessMessage,
} from '../gateway-wire/transport.js';
import { ChatAction } from '../action/ChatAction.js';
import { CreateSessionAction } from '../action/CreateSessionAction.js';
import { CloseSessionAction } from '../action/CloseSessionAction.js';
import { PermissionReplyAction } from '../action/PermissionReplyAction.js';
import { StatusQueryAction } from '../action/StatusQueryAction.js';
import { AbortSessionAction } from '../action/AbortSessionAction.js';
import { QuestionReplyAction } from '../action/QuestionReplyAction.js';
import { DefaultActionRouter } from '../action/ActionRouter.js';
import { DefaultActionRegistry } from '../action/ActionRegistry.js';
import { EnvBridgeChannelAdapter, JsonAssiantDirectoryMappingAdapter, OpencodeSessionGatewayAdapter } from '../adapter/index.js';
import {
  InMemoryOpencodeSessionOwnershipResolver,
  InMemorySessionModelOverrideStore,
  InMemoryToolSessionBindingStore,
  SimpleSlashCommandParser,
} from '../adapter/index.js';
import {
  buildGatewayRegisterMessage,
  createAkSkAuthProvider,
  createGatewayClient,
  type GatewayBusinessMessage,
  type GatewayClientErrorShape,
  type GatewayInboundFrame,
  type GatewayClient,
  type GatewayClientConfig,
  type GatewaySendContext as GatewaySendLogContext,
  type GatewaySendPayload,
} from '@agent-plugin/gateway-client';
import { loadConfig } from '../config/index.js';
import { EventFilter } from '../event/EventFilter.js';
import {
  extractUpstreamEvent,
  type MessagePartExtra,
  type MessageUpdatedExtra,
  type NormalizedUpstreamEvent,
  type SessionCreatedExtra,
  type SessionStatusExtra,
} from '../protocol/upstream/index.js';
import {
  DOWNSTREAM_MESSAGE_TYPE,
} from '../gateway-wire/downstream.js';
import { TOOL_TYPE_OPENX } from '../contracts/transport-messages.js';
import { TOOL_EVENT_TYPE } from '../gateway-wire/tool-event.js';
import {
  adaptGatewayBusinessMessage,
  type DownstreamNormalizationError,
  InvalidInvokeToolErrorResponder,
} from '../protocol/downstream/index.js';
import { ChatUseCase, CreateSessionUseCase, ResolveCreateSessionDirectoryUseCase } from '../usecase/index.js';
import { BridgeEvent } from './types.js';
import { createSdkAdapter, getMissingSdkCapabilities, toHostClientLike } from './SdkAdapter.js';
import { AppLogger, type BridgeLogger } from './AppLogger.js';
import { ToolDoneCompat, type ToolDoneSource } from './compat/ToolDoneCompat.js';
import { SyntheticAssistantReplySender } from './SyntheticAssistantReplySender.js';
import { SubagentSessionMapper } from '../session/SubagentSessionMapper.js';
import { resolvePluginVersion } from './pluginVersion.js';
import { resolveRegisterMetadata } from './RegisterMetadata.js';
import { warnUnknownToolType } from './ToolTypeWarning.js';
import { isBridgeStartupError, type BridgeStartupError, validateBridgeStartup } from './Startup.js';
import { createBridgeRuntimeStatusAdapter, type BridgeRuntimeStatusAdapter } from './BridgeRuntimeStatusAdapter.js';
import { resetMessageBridgeStatus } from './MessageBridgeStatusStore.js';
import { BindingAwareChatRouter, HandledSlashCommandFailure } from './BindingAwareChatRouter.js';
import { MemoryGatewayEnvelopeProjector } from './GatewayEnvelopeProjector.js';
import {
  DefaultGatewayLifecycleCoordinator,
  type GatewayLifecycleCoordinator,
  type GatewayLifecyclePort,
} from './GatewayLifecycleCoordinator.js';
import {
  DefaultGatewaySessionSender,
  type GatewaySessionSenderPort,
} from './GatewaySessionSender.js';
import { RuntimeSlashCommandCompletionPort } from './SlashCommandCompletionPort.js';
import {
  DefaultUpstreamTransportProjector,
  type UpstreamTransportProjector,
} from '../transport/upstream/index.js';
import type {
  HostModelInfo,
  HostSessionInfo,
  SessionScope,
} from '../port/SlashCommandControlPlanePort.js';
import type { BridgeSdkClient, HostClientLike } from '../types/index.js';
import { getErrorDetailsForLog, getErrorMessage } from '../utils/error.js';
import { getToolErrorEvidence } from '../utils/error.js';
import { asRecord, asString, asTrimmedString } from '../utils/type-guards.js';
import {
  DefaultSlashCommandOrchestrator,
  DefaultSlashCommandReplyPresenter,
  ResolveSlashCommandContextUseCase,
} from '../usecase/index.js';

export interface BridgeRuntimeOptions {
  workspacePath?: string;
  hostDirectory?: string;
  client: unknown;
  runtimeTraceId?: string;
}

export interface BridgeRuntimeStartOptions {
  abortSignal?: AbortSignal;
}

interface EventLogFields {
  eventType: string;
  toolSessionId: string;
  opencodeMessageId?: string;
  opencodePartId?: string;
  role?: string | null;
  status?: string | null;
  partType?: string | null;
  toolCallId?: string | null;
  deltaBytes?: number | null;
}

interface DownstreamLogFields {
  messageType?: string;
  gatewayMessageId?: string;
  action?: string;
  welinkSessionId?: string;
  toolSessionId?: string;
}

type RuntimeToolDoneSource = ToolDoneSource | 'deny_fast_path';
const GROUP_CHAT_DENY_REPLY_TEXT = '本机器人不处理群聊消息，请勿在群内@提问';

function isGatewayClientErrorShape(error: unknown): error is GatewayClientErrorShape {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && 'disposition' in error
    && 'stage' in error
    && 'retryable' in error
    && 'message' in error;
}
const MESSAGE_BRIDGE_RUNTIME_DISABLED = 'message_bridge_runtime_disabled';

export class BridgeRuntime {
  private readonly actionRouter = new DefaultActionRouter();
  private readonly registry = new DefaultActionRegistry();
  private readonly upstreamTransportProjector: UpstreamTransportProjector = new DefaultUpstreamTransportProjector();
  private readonly bridgeChannelPort: EnvBridgeChannelAdapter;
  private readonly assiantDirectoryMappingPort: JsonAssiantDirectoryMappingAdapter;
  private readonly opencodeSessionGatewayAdapter: OpencodeSessionGatewayAdapter;
  private readonly resolveCreateSessionDirectoryUseCase: ResolveCreateSessionDirectoryUseCase;
  private readonly createSessionUseCase: CreateSessionUseCase;
  private readonly chatUseCase: ChatUseCase;
  private readonly bindingStore = new InMemoryToolSessionBindingStore();
  private readonly ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  private readonly sessionModelOverrideStore = new InMemorySessionModelOverrideStore();
  private readonly slashCommandParser = new SimpleSlashCommandParser();
  private readonly gatewayEnvelopeProjector = new MemoryGatewayEnvelopeProjector();
  private readonly slashCommandCompletionPort: RuntimeSlashCommandCompletionPort;
  private readonly slashCommandContextResolver: ResolveSlashCommandContextUseCase;
  private readonly slashCommandOrchestrator: DefaultSlashCommandOrchestrator;
  private readonly bindingAwareChatRouter: BindingAwareChatRouter;

  private eventFilter: EventFilter | null = null;
  private started = false;
  private readonly rawClient: HostClientLike;
  private sdkClient: BridgeSdkClient | null;
  private readonly missingSdkCapabilities: ReturnType<typeof getMissingSdkCapabilities>;
  private readonly workspacePath?: string;
  private readonly hostDirectory?: string;
  private effectiveDirectory?: string;
  private logger: BridgeLogger;
  private readonly toolDoneCompat = new ToolDoneCompat();
  private readonly toolErrorClassifier = new ToolErrorClassifier();
  private readonly invalidInvokeToolErrorResponder: InvalidInvokeToolErrorResponder;
  private readonly subagentSessionMapper = new SubagentSessionMapper(() => this.sdkClient);
  private readonly statusAdapter: BridgeRuntimeStatusAdapter;
  private readonly lifecycleCoordinator: GatewayLifecycleCoordinator;
  private readonly sessionSender: GatewaySessionSenderPort;
  private readonly syntheticAssistantReplySender: SyntheticAssistantReplySender;
  private gatewayConnectionOverride: GatewayClient | null = null;
  private sessionDirectoryPolicyContext: {
    channel?: string;
    bridgeDirectoryConfigured: boolean;
  } = {
    channel: TOOL_TYPE_OPENX,
    bridgeDirectoryConfigured: true,
  };

  constructor(options: BridgeRuntimeOptions) {
    this.workspacePath = options.workspacePath;
    this.hostDirectory = options.hostDirectory;
    this.rawClient = toHostClientLike(options.client);
    this.missingSdkCapabilities = getMissingSdkCapabilities(options.client);
    this.logger = new AppLogger(this.rawClient, { component: 'runtime' }, options.runtimeTraceId);
    this.sdkClient = createSdkAdapter(options.client);
    this.bridgeChannelPort = new EnvBridgeChannelAdapter();
    this.assiantDirectoryMappingPort = new JsonAssiantDirectoryMappingAdapter(
      process.env.BRIDGE_ASSISTANT_DIRECTORY_MAP_FILE?.trim(),
      () => this.logger,
    );
    this.opencodeSessionGatewayAdapter = new OpencodeSessionGatewayAdapter(
      () => this.sdkClient,
      () => this.sessionDirectoryPolicyContext,
    );
    this.resolveCreateSessionDirectoryUseCase = new ResolveCreateSessionDirectoryUseCase(
      this.bridgeChannelPort,
      this.assiantDirectoryMappingPort,
      this.logger,
    );
    this.createSessionUseCase = new CreateSessionUseCase(
      this.resolveCreateSessionDirectoryUseCase,
      this.opencodeSessionGatewayAdapter,
    );
    this.chatUseCase = new ChatUseCase(this.opencodeSessionGatewayAdapter);
    this.slashCommandCompletionPort = new RuntimeSlashCommandCompletionPort({
      projector: this.gatewayEnvelopeProjector,
      sender: async (message) => this.sendControlPlaneMessage(message),
    });
    this.slashCommandContextResolver = new ResolveSlashCommandContextUseCase({
      bindingStore: this.bindingStore,
      ownershipResolver: this.ownershipResolver,
      modelOverrideStore: this.sessionModelOverrideStore,
      hostSessionCreationPort: {
        createSession: async (input) => this.createControlPlaneSession(input),
      },
      hostSessionQueryPort: {
        getSession: async (sessionId) => this.getControlPlaneSession(sessionId),
        listSessions: async (scope) => this.listControlPlaneSessions(scope),
      },
    });
    this.slashCommandOrchestrator = new DefaultSlashCommandOrchestrator({
      bindingStore: this.bindingStore,
      ownershipResolver: this.ownershipResolver,
      modelOverrideStore: this.sessionModelOverrideStore,
      hostSessionCreationPort: {
        createSession: async (input) => this.createControlPlaneSession(input),
      },
      hostSessionQueryPort: {
        getSession: async (sessionId) => this.getControlPlaneSession(sessionId),
        listSessions: async (scope) => this.listControlPlaneSessions(scope),
      },
      hostPromptExecutionPort: {
        prompt: async (input) => this.promptControlPlaneSession(input),
      },
      hostModelCatalogPort: {
        listModels: async () => this.listControlPlaneModels(),
      },
      replyPresenter: new DefaultSlashCommandReplyPresenter(),
      completionPort: this.slashCommandCompletionPort,
    });
    this.bindingAwareChatRouter = new BindingAwareChatRouter({
      contextResolver: this.slashCommandContextResolver,
      slashCommandParser: this.slashCommandParser,
      slashCommandOrchestrator: this.slashCommandOrchestrator,
      hostPromptExecutionPort: {
        prompt: async (input) => this.promptControlPlaneSession(input),
      },
    });
    this.statusAdapter = createBridgeRuntimeStatusAdapter();
    this.invalidInvokeToolErrorResponder = new InvalidInvokeToolErrorResponder({
      sendToolError: (result, welinkSessionId, logOptions) => this.sendToolError(result, welinkSessionId, logOptions),
      canReply: () => this.getActiveGatewayConnection()?.getStatus().isReady() ?? false,
      getConnectionState: () => this.getActiveGatewayConnection()?.getState(),
    });
    this.lifecycleCoordinator = new DefaultGatewayLifecycleCoordinator(this.createGatewayLifecyclePort());
    this.sessionSender = new DefaultGatewaySessionSender({
      getActiveConnection: () => this.getActiveGatewayConnection(),
      getLogger: () => this.logger,
    });
    this.syntheticAssistantReplySender = new SyntheticAssistantReplySender(
      this.sessionSender,
      (message, logContext, logger) => this.validateGatewayUplinkBusinessMessageOrLog(message, logContext, logger),
    );
    this.registerActions();
    this.actionRouter.setRegistry(this.registry);
  }

  protected async resolveConfig() {
    return loadConfig(this.workspacePath, this.logger);
  }

  protected createGatewayConnection(options: GatewayClientConfig): GatewayClient {
    return createGatewayClient(options);
  }

  /**
   * 仅用于现有单测/夹具直连注入 connection。
   * @remarks 正常运行期始终优先使用 lifecycle coordinator 管理 active connection。
   */
  get gatewayConnection(): GatewayClient | null {
    return this.gatewayConnectionOverride ?? this.lifecycleCoordinator.getActiveConnection();
  }

  set gatewayConnection(connection: GatewayClient | null) {
    this.gatewayConnectionOverride = connection;
  }

  async start(options: BridgeRuntimeStartOptions = {}): Promise<void> {
    const pluginVersion = resolvePluginVersion();
    this.logger.info('runtime.start.requested', {
      workspacePath: this.workspacePath,
      hostDirectory: this.hostDirectory,
      pluginVersion,
    });
    if (this.started) {
      this.logger.debug('runtime.start.skipped_already_started');
      return;
    }

    if (options.abortSignal?.aborted) {
      this.logger.warn('runtime.start.aborted_precheck');
      throw new Error('runtime_start_aborted');
    }

    let config;
    let effectiveDebug = false;
    try {
      this.logger.info('runtime.config.loading', { workspacePath: this.workspacePath });
      config = await this.resolveConfig();
      this.bridgeChannelPort.setChannel(config.gateway.channel);
      effectiveDebug = !!config.debug;
      this.logger = new AppLogger(
        this.rawClient,
        { component: 'runtime' },
        this.logger.getTraceId(),
        undefined,
        effectiveDebug,
      );
      this.logger.info('runtime.config.loaded_successfully', {
        config_version: config.config_version,
        enabled: config.enabled,
        gateway_url: config.gateway.url,
        bridgeDirectory: config.bridgeDirectory,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.error('runtime.config.loading_failed', {
        error: errorMessage,
        workspacePath: this.workspacePath,
      });
      this.statusAdapter.publishConfigInvalid(errorMessage);
      throw error;
    }
    if (!config.enabled) {
      const disabledError = new Error(MESSAGE_BRIDGE_RUNTIME_DISABLED);
      this.statusAdapter.publishDisabled(disabledError.message);
      this.logger.info('runtime.start.disabled_by_config');
      throw disabledError;
    }

    this.effectiveDirectory = config.bridgeDirectory ?? this.hostDirectory;
    this.sessionDirectoryPolicyContext = {
      channel: config.gateway.channel,
      bridgeDirectoryConfigured: Boolean(config.bridgeDirectory),
    };
    this.logger.info('runtime.directory.resolved', {
      workspacePath: this.workspacePath,
      hostDirectory: this.hostDirectory,
      effectiveDirectory: this.effectiveDirectory,
      directorySource: config.bridgeDirectory ? 'env' : this.hostDirectory ? 'host_input' : 'none',
      sessionDirectoryPolicyChannel: this.sessionDirectoryPolicyContext.channel,
      sessionDirectoryPolicyBridgeDirectoryConfigured: this.sessionDirectoryPolicyContext.bridgeDirectoryConfigured,
    });

    let startupValidation;
    try {
      startupValidation = await this.validateStartupPrerequisites();
    } catch (error) {
      this.statusAdapter.publishPluginFailure(getErrorMessage(error));
      throw error;
    }
    this.sdkClient = startupValidation.sdkClient;
    this.eventFilter = new EventFilter(config.events.allowlist);
    const registerMetadata = resolveRegisterMetadata(startupValidation.health.version, this.logger);
    warnUnknownToolType(this.logger, 'runtime.register.tool_type.unknown', config.gateway.channel, {
      workspacePath: this.workspacePath,
    });

    const authProvider = createAkSkAuthProvider(config.auth.ak, config.auth.sk);
    const authPayloadProvider = () => authProvider.generateAuthPayload();

    const connection = this.createGatewayConnection({
      url: config.gateway.url,
      debug: effectiveDebug,
      reconnect: config.gateway.reconnect,
      heartbeatIntervalMs: config.gateway.heartbeatIntervalMs,
      abortSignal: options.abortSignal,
      authPayloadProvider,
      registerMessage: buildGatewayRegisterMessage({
        deviceName: registerMetadata.deviceName,
        os: os.platform(),
        toolType: config.gateway.channel,
        toolVersion: registerMetadata.toolVersion,
        macAddress: registerMetadata.macAddress,
      }),
      logger: this.logger.child({ component: 'gateway' }),
    });

    this.gatewayConnectionOverride = null;
    this.statusAdapter.publishConnecting();
    if (options.abortSignal?.aborted) {
      // connection 尚未交给 lifecycle coordinator 接管，当前分支仍由 runtime 负责释放。
      connection.disconnect();
      this.logger.warn('runtime.start.aborted_before_connect');
      throw new Error('runtime_start_aborted');
    }

    try {
      await this.lifecycleCoordinator.startSession(connection, { abortSignal: options.abortSignal });
    } catch (error) {
      if (isGatewayClientErrorShape(error)) {
        this.statusAdapter.publishGatewayError(error);
      }
      throw error;
    }
    if (options.abortSignal?.aborted) {
      this.lifecycleCoordinator.stopSession();
      this.logger.warn('runtime.start.aborted_after_connect');
      throw new Error('runtime_start_aborted');
    }

    this.started = true;
    this.logger.info('runtime.start.completed');
  }

  stop(): void {
    this.logger.info('runtime.stop.requested');
    this.lifecycleCoordinator.stopSession();
    this.gatewayConnectionOverride = null;
    this.started = false;
    resetMessageBridgeStatus();
    this.logger.info('runtime.stop.completed');
  }

  private handleInboundFrame(frame: GatewayInboundFrame): void {
    this.invalidInvokeToolErrorResponder.respond(frame, this.logger);
  }

  async handleEvent(event: BridgeEvent): Promise<void> {
    // 这里是宿主事件进入 gateway uplink 的唯一主链路：
    // 先抽取可路由字段，再做投影，最后统一经过共享 validator，任何失败都 fail-closed。
    const extraction = extractUpstreamEvent(event, this.logger);
    if (!extraction.ok) {
      return;
    }

    const normalized = extraction.value;
    const eventFields = this.buildEventLogFields(normalized);
    const eventTraceId = eventFields.opencodeMessageId ?? this.logger.getTraceId();
    const eventLogger = this.createMessageLogger(eventFields, eventTraceId);
    eventLogger.debug('event.received');

    // session.created 只用于预热父子 session 映射，不参与业务 allowlist 和上行转发。
    if (normalized.common.eventType === 'session.created') {
      this.recordSessionCreated(normalized, eventLogger);
      eventLogger.debug('event.control_session_created');
      return;
    }

    const connection = this.getActiveGatewayConnection();
    if (!connection || !connection.getStatus().isReady() || !this.eventFilter) {
      eventLogger.debug('event.ignored_not_ready', {
        state: connection?.getState(),
      });
      return;
    }

    if (!this.eventFilter.isAllowed(normalized.common.eventType)) {
      eventLogger.warn('event.rejected_allowlist');
      return;
    }

    const bridgeMessageId = randomUUID();
    const forwardingLogger = this.createMessageLogger(eventFields, bridgeMessageId);
    this.logEventForwardingDetail(normalized, forwardingLogger);
    // child session 的外层 envelope 聚合到 parent，原始 event 内部 session 字段保持 OpenCode 原貌。
    const subagentResolution = await this.subagentSessionMapper.resolve(normalized.common.toolSessionId);
    if (subagentResolution.status === 'lookup_failed') {
      forwardingLogger.warn('event.subagent_lookup_failed', {
        toolSessionId: normalized.common.toolSessionId,
        ...getErrorDetailsForLog(subagentResolution.error),
      });
    }
    const subagentMapping = subagentResolution.status === 'mapped' ? subagentResolution.mapping : null;
    const ownershipSessionId = subagentMapping?.parentSessionId ?? normalized.common.toolSessionId;
    const envelopeToolSessionId = this.ownershipResolver.resolveAttachedAnchor(ownershipSessionId);
    if (!envelopeToolSessionId) {
      forwardingLogger.debug('event.dropped_unowned', {
        opencodeSessionId: normalized.common.toolSessionId,
        ownershipSessionId,
      });
      return;
    }
    const subagentEnvelopeFields = subagentMapping
      ? {
          subagentSessionId: subagentMapping.childSessionId,
          subagentName: subagentMapping.agentName,
        }
      : {};
    forwardingLogger.info('event.forwarding');
    const transportEvent = this.upstreamTransportProjector.project(normalized);
    const rawEvent = normalized.raw;
    const transportEnvelope: GatewaySendPayload = {
      type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
      toolSessionId: envelopeToolSessionId,
      ...subagentEnvelopeFields,
      event: transportEvent,
    };
    const originalEnvelope = {
      type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
      toolSessionId: envelopeToolSessionId,
      ...subagentEnvelopeFields,
      event: rawEvent,
    };
    const transportLogContext: GatewaySendLogContext = {
      traceId: bridgeMessageId,
      runtimeTraceId: this.logger.getTraceId(),
      gatewayMessageId: bridgeMessageId,
      toolSessionId: envelopeToolSessionId,
      eventType: normalized.common.eventType,
      opencodeMessageId: eventFields.opencodeMessageId,
      opencodePartId: eventFields.opencodePartId,
      toolCallId: eventFields.toolCallId ?? undefined,
      originalPayloadBytes: Buffer.byteLength(JSON.stringify(originalEnvelope), 'utf8'),
      transportPayloadBytes: Buffer.byteLength(JSON.stringify(transportEnvelope), 'utf8'),
    };
    const validatedEnvelope = this.validateGatewayUplinkBusinessMessageOrLog(
      transportEnvelope,
      transportLogContext,
      forwardingLogger,
    );
    if (!validatedEnvelope) {
      return;
    }
    if (this.sessionSender.sendIfActive(connection, validatedEnvelope, transportLogContext)) {
      forwardingLogger.debug('event.forwarded');
    }

    // child session 的 idle 仅代表子代理收尾，不能向 parent 额外补发 tool_done。
    if (normalized.common.eventType === TOOL_EVENT_TYPE.SESSION_IDLE && !subagentMapping) {
      const decision = this.toolDoneCompat.handleSessionIdle({
        toolSessionId: envelopeToolSessionId,
        logger: forwardingLogger,
      });
      if (decision.emit && decision.source) {
        const sent = this.sendToolDone(envelopeToolSessionId, undefined, decision.source, {
          connection,
          logger: forwardingLogger,
          traceId: bridgeMessageId,
          gatewayMessageId: bridgeMessageId,
        });
        if (sent) {
          this.toolDoneCompat.handleToolDoneSent({
            toolSessionId: envelopeToolSessionId,
            source: decision.source,
            logger: forwardingLogger,
          });
        } else {
          this.toolDoneCompat.handleToolDoneSendFailed({
            toolSessionId: envelopeToolSessionId,
            source: decision.source,
            logger: forwardingLogger,
          });
        }
      }
    }
  }

  private recordSessionCreated(normalized: NormalizedUpstreamEvent, logger: BridgeLogger): void {
    const extra = normalized.extra as SessionCreatedExtra | undefined;
    if (!extra || extra.kind !== 'session.created') {
      logger.warn('event.control_session_created_invalid_extra');
      return;
    }

    this.subagentSessionMapper.recordSessionCreated({
      childSessionId: normalized.common.toolSessionId,
      parentSessionId: extra.parentSessionId,
      agentName: extra.agentName,
    });
  }

  getStarted(): boolean {
    return this.started;
  }

  private registerActions(): void {
    const actions = [
      new ChatAction(this.chatUseCase),
      new CreateSessionAction(this.createSessionUseCase),
      new CloseSessionAction(this.opencodeSessionGatewayAdapter),
      new PermissionReplyAction(this.opencodeSessionGatewayAdapter),
      new StatusQueryAction(),
      new AbortSessionAction(this.opencodeSessionGatewayAdapter),
      new QuestionReplyAction(this.opencodeSessionGatewayAdapter),
    ] as const;

    for (const action of actions) {
      this.registry.register(action);
    }
  }

  private async handleDownstreamMessage(message: GatewayBusinessMessage): Promise<void> {
    // 这里是 gateway 业务消息进入 runtime 的唯一主链路：
    // 只做业务分发和 fail-closed 错误映射，不再承担共享协议归一化。
    const connection = this.getActiveGatewayConnection();
    if (!connection) {
      this.logger.warn('runtime.downstream_ignored_no_connection');
      return;
    }
    const startedAt = Date.now();
    const downstreamFields = this.extractDownstreamLogFields(message);
    const traceId = downstreamFields.gatewayMessageId ?? this.logger.getTraceId();
    const messageLogger = this.createMessageLogger(downstreamFields, traceId);
    const adaptedMessage = adaptGatewayBusinessMessage(message, messageLogger);
    if (!adaptedMessage.ok) {
      this.sendToolError(
        this.toDownstreamValidationFailure(adaptedMessage.error),
        adaptedMessage.error.welinkSessionId ?? downstreamFields.welinkSessionId,
        {
          logger: messageLogger,
          traceId,
          gatewayMessageId: downstreamFields.gatewayMessageId,
          action: adaptedMessage.error.action ?? downstreamFields.action,
          toolSessionId: downstreamFields.toolSessionId,
        },
      );
      return;
    }

    if (adaptedMessage.value.type === DOWNSTREAM_MESSAGE_TYPE.STATUS_QUERY) {
      const statusLogger = this.createMessageLogger(
        { ...downstreamFields },
        traceId,
      );
      statusLogger.info('runtime.status_query.received');
      const payload: StatusQueryPayload = {};
      const result = await this.actionRouter.route(
        DOWNSTREAM_MESSAGE_TYPE.STATUS_QUERY,
        payload,
        this.buildActionContext(connection, undefined, statusLogger),
      );
      if (!result.success) {
        this.sendToolError(result, undefined, {
          connection,
          logger: statusLogger,
          traceId,
          gatewayMessageId: downstreamFields.gatewayMessageId,
          action: DOWNSTREAM_MESSAGE_TYPE.STATUS_QUERY,
        });
        return;
      }

      const statusResponse: GatewaySendPayload = {
        type: UPSTREAM_MESSAGE_TYPE.STATUS_RESPONSE,
        opencodeOnline: result.data.opencodeOnline,
      };
      const statusLogContext: GatewaySendLogContext = {
        traceId,
        runtimeTraceId: this.logger.getTraceId(),
        gatewayMessageId: downstreamFields.gatewayMessageId,
        action: DOWNSTREAM_MESSAGE_TYPE.STATUS_QUERY,
      };
      const validatedStatusResponse = this.validateGatewayUplinkBusinessMessageOrLog(
        statusResponse,
        statusLogContext,
        statusLogger,
      );
      if (!validatedStatusResponse) {
        return;
      }
      if (this.sessionSender.sendIfActive(connection, validatedStatusResponse, statusLogContext)) {
        statusLogger.info('runtime.status_query.responded', {
          latencyMs: Date.now() - startedAt,
        });
      }
      return;
    }

    const invokeMessage = adaptedMessage.value;
    const welinkSessionId = invokeMessage.welinkSessionId;
    const toolSessionId =
      'toolSessionId' in invokeMessage.payload &&
      typeof invokeMessage.payload.toolSessionId === 'string'
        ? invokeMessage.payload.toolSessionId
        : undefined;
    const invokeLogger = this.createMessageLogger(
      {
        ...downstreamFields,
        welinkSessionId,
        action: invokeMessage.action,
        toolSessionId,
      },
      traceId,
    );

    if (!connection.getStatus().isReady()) {
      invokeLogger.warn('runtime.invoke.ignored_not_ready', {
        state: connection.getState(),
      });
      return;
    }

    invokeLogger.info('runtime.invoke.received');

    if (invokeMessage.action === 'create_session') {
      const normalizedWelinkSessionId = asTrimmedString(invokeMessage.welinkSessionId) ?? invokeMessage.welinkSessionId;
      const result = await this.actionRouter.route(
        invokeMessage.action,
        invokeMessage.payload,
        this.buildActionContext(connection, normalizedWelinkSessionId, invokeLogger),
      );

      if (!result.success) {
        this.sendToolError(result, welinkSessionId, {
          connection,
          logger: invokeLogger,
          traceId,
          gatewayMessageId: downstreamFields.gatewayMessageId,
          action: invokeMessage.action,
        });
        return;
      }

      const toolSessionId = result.data.sessionId;
      if (!toolSessionId) {
        this.sendToolError(
          { success: false, errorCode: 'SDK_UNREACHABLE', errorMessage: 'create_session returned without sessionId' },
          welinkSessionId,
          {
            connection,
            logger: invokeLogger,
            traceId,
            gatewayMessageId: downstreamFields.gatewayMessageId,
            action: invokeMessage.action,
          },
        );
        return;
      }

      // 首次 create_session/session_created 是临时态建链入口，必须同步建立 binding/ownership。
      this.bindingStore.bind(toolSessionId, toolSessionId);
      this.ownershipResolver.attach(toolSessionId, toolSessionId);

      const sessionCreated: GatewaySendPayload = {
        type: UPSTREAM_MESSAGE_TYPE.SESSION_CREATED,
        welinkSessionId: normalizedWelinkSessionId,
        toolSessionId,
        session: result.data,
      };
      const sessionCreatedLogContext: GatewaySendLogContext = {
        traceId,
        runtimeTraceId: this.logger.getTraceId(),
        gatewayMessageId: downstreamFields.gatewayMessageId,
        welinkSessionId: normalizedWelinkSessionId,
        toolSessionId,
        action: invokeMessage.action,
      };
      const validatedSessionCreated = this.validateGatewayUplinkBusinessMessageOrLog(
        sessionCreated,
        sessionCreatedLogContext,
        invokeLogger,
      );
      if (!validatedSessionCreated) {
        return;
      }
      if (this.sessionSender.sendIfActive(connection, validatedSessionCreated, sessionCreatedLogContext)) {
        invokeLogger.info('runtime.invoke.completed', {
          action: invokeMessage.action,
          welinkSessionId: normalizedWelinkSessionId,
          toolSessionId,
          latencyMs: Date.now() - startedAt,
        });
      }
      return;
    }

    if (invokeMessage.action === 'chat' && invokeMessage.suppressReply === true && toolSessionId) {
      invokeLogger.info('runtime.invoke.chat_deny_fast_path', {
        toolSessionId,
        welinkSessionId,
      });
      const denyResult = this.syntheticAssistantReplySender.execute({
        connection,
        toolSessionId,
        welinkSessionId,
        text: GROUP_CHAT_DENY_REPLY_TEXT,
        logger: invokeLogger,
        traceId,
        gatewayMessageId: downstreamFields.gatewayMessageId,
        action: 'chat',
        sendToolDone: (nextToolSessionId, nextWelinkSessionId, logOptions) =>
          this.sendToolDone(nextToolSessionId, nextWelinkSessionId, 'deny_fast_path', logOptions),
      });
      if (!denyResult.success) {
        invokeLogger.error('runtime.invoke.chat_deny_fast_path_failed', {
          toolSessionId,
          welinkSessionId,
          failureStage: denyResult.failureStage,
          latencyMs: Date.now() - startedAt,
        });
        return;
      }

      invokeLogger.info('runtime.invoke.completed', {
        action: 'chat',
        welinkSessionId,
        toolSessionId,
        completionSource: 'deny_fast_path',
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    if (invokeMessage.action === 'chat' && toolSessionId) {
      this.toolDoneCompat.handleInvokeStarted({
        action: invokeMessage.action,
        toolSessionId,
      });
      try {
        const routeResult = await this.bindingAwareChatRouter.route({
          anchor: toolSessionId,
          text: invokeMessage.payload.text,
          assistantId: invokeMessage.payload.assistantId,
          logger: invokeLogger,
        });
        if (routeResult.kind === 'slash_completed') {
          this.toolDoneCompat.handleInvokeFailed({
            action: invokeMessage.action,
            toolSessionId,
          });
          invokeLogger.info('runtime.invoke.completed', {
            action: invokeMessage.action,
            welinkSessionId,
            toolSessionId,
            completionSource: 'slash_control_plane',
            latencyMs: Date.now() - startedAt,
          });
          return;
        }
      } catch (error) {
        this.toolDoneCompat.handleInvokeFailed({
          action: invokeMessage.action,
          toolSessionId,
        });
        const slashSourceError = error instanceof HandledSlashCommandFailure ? error.sourceError : error;
        this.handleControlPlanePromptFailure(toolSessionId, slashSourceError);
        if (error instanceof HandledSlashCommandFailure) {
          return;
        }
        this.sendToolError(
          this.toControlPlaneActionFailure(error),
          welinkSessionId,
          {
            connection,
            logger: invokeLogger,
            traceId,
            gatewayMessageId: downstreamFields.gatewayMessageId,
            action: invokeMessage.action,
            toolSessionId,
          },
        );
        return;
      }

      invokeLogger.info('runtime.invoke.completed', {
        action: invokeMessage.action,
        welinkSessionId,
        toolSessionId,
        latencyMs: Date.now() - startedAt,
      });
      const decision = this.toolDoneCompat.handleInvokeCompleted({
        action: invokeMessage.action,
        toolSessionId,
        logger: invokeLogger,
      });
      if (decision.emit && decision.source) {
        const sent = this.sendToolDone(toolSessionId, welinkSessionId, decision.source, {
          connection,
          logger: invokeLogger,
          traceId,
          gatewayMessageId: downstreamFields.gatewayMessageId,
          action: invokeMessage.action,
        });
        if (sent) {
          this.toolDoneCompat.handleToolDoneSent({
            toolSessionId,
            source: decision.source,
            logger: invokeLogger,
          });
        } else {
          this.toolDoneCompat.handleToolDoneSendFailed({
            toolSessionId,
            source: decision.source,
            logger: invokeLogger,
          });
        }
      }
      return;
    }

    this.toolDoneCompat.handleInvokeStarted({
      action: invokeMessage.action,
      toolSessionId,
    });
    const result = await this.actionRouter.route(
      invokeMessage.action,
      invokeMessage.payload,
      this.buildActionContext(connection, welinkSessionId, invokeLogger),
    );

    if (!result.success) {
      this.toolDoneCompat.handleInvokeFailed({
        action: invokeMessage.action,
        toolSessionId,
      });
      this.sendToolError(result, welinkSessionId, {
        connection,
        logger: invokeLogger,
        traceId,
        gatewayMessageId: downstreamFields.gatewayMessageId,
        action: invokeMessage.action,
        toolSessionId,
      });
      return;
    }

    invokeLogger.info('runtime.invoke.completed', {
      action: invokeMessage.action,
      welinkSessionId,
      toolSessionId,
      latencyMs: Date.now() - startedAt,
    });

    const decision = this.toolDoneCompat.handleInvokeCompleted({
      action: invokeMessage.action,
      toolSessionId,
      logger: invokeLogger,
    });
    if (decision.emit && toolSessionId && decision.source) {
      const sent = this.sendToolDone(toolSessionId, welinkSessionId, decision.source, {
        connection,
        logger: invokeLogger,
        traceId,
        gatewayMessageId: downstreamFields.gatewayMessageId,
        action: invokeMessage.action,
      });
      if (sent) {
        this.toolDoneCompat.handleToolDoneSent({
          toolSessionId,
          source: decision.source,
          logger: invokeLogger,
        });
      } else {
        this.toolDoneCompat.handleToolDoneSendFailed({
          toolSessionId,
          source: decision.source,
          logger: invokeLogger,
        });
      }
    }
  }

  private toDownstreamValidationFailure(error: DownstreamNormalizationError): ActionResult {
    return {
      success: false,
      errorCode: 'INVALID_PAYLOAD',
      errorMessage:
        error.action === 'create_session' && error.field === 'welinkSessionId'
          ? 'welinkSessionId is required'
          : 'Invalid invoke payload shape',
      errorEvidence: {
        sourceErrorCode: error.code,
      },
    };
  }

  private buildActionContext(
    connection: GatewayClient | null,
    welinkSessionId?: string,
    logger: BridgeLogger = this.logger,
  ) {
    if (!this.sdkClient) {
      throw new Error('runtime.sdk_client_unavailable');
    }
    if (!connection) {
      throw new Error('runtime.gateway_connection_unavailable');
    }

    return {
      client: this.sdkClient,
      hostClient: this.rawClient,
      connectionState: connection.getState(),
      welinkSessionId,
      effectiveDirectory: this.effectiveDirectory,
      assiantDirectoryMappingConfigured: this.assiantDirectoryMappingPort.isConfigured(),
      logger: logger.child({
        component: 'action',
        welinkSessionId,
      }),
    };
  }

  /** 控制面会话创建入口：把 SDK 结果收口为稳定宿主会话视图。 */
  private async createControlPlaneSession(input?: { title?: string; directory?: string }): Promise<HostSessionInfo> {
    const result = await this.opencodeSessionGatewayAdapter.createSession(input ?? {});
    if (!result.success) {
      throw this.toControlPlaneError(result);
    }

    const session = asRecord(result.data.session);
    const sessionId = asTrimmedString(result.data.sessionId) ?? asTrimmedString(session?.id);
    if (!sessionId) {
      throw new Error('control_plane.session_create_missing_id');
    }

    return {
      id: sessionId,
      title: asTrimmedString(session?.title),
      projectID: asTrimmedString(session?.projectID),
      workspaceID: asTrimmedString(session?.workspaceID),
      directory: asTrimmedString(session?.directory),
    };
  }

  /** 控制面会话查询入口：只解析当前所需字段，不向 use case 泄露 SDK 原始结构。 */
  private async getControlPlaneSession(sessionId: string): Promise<HostSessionInfo> {
    const client = this.requireSdkClient();
    let payload: unknown;
    try {
      const result = await client.session.get({ sessionID: sessionId });
      payload = this.unwrapSdkData(result);
    } catch (error) {
      throw {
        errorCode: 'SDK_UNREACHABLE',
        errorMessage: 'Failed to send message',
        errorEvidence: getToolErrorEvidence(error, 'session.get'),
      };
    }
    const session = asRecord(payload);
    const resolvedId = asTrimmedString(session?.id);
    if (!resolvedId) {
      throw new Error(`control_plane.session_get_missing_id:${sessionId}`);
    }

    return {
      id: resolvedId,
      title: asTrimmedString(session?.title),
      projectID: asTrimmedString(session?.projectID),
      workspaceID: asTrimmedString(session?.workspaceID),
      directory: asTrimmedString(session?.directory),
    };
  }

  /** 控制面会话列表入口：按 scope 快照请求宿主并收口字段。 */
  private async listControlPlaneSessions(scope: SessionScope): Promise<HostSessionInfo[]> {
    const client = this.requireSdkClient();
    const result = await client.session.list({
      ...(scope.directory ? { directory: scope.directory } : {}),
    });
    const payload = this.unwrapSdkData(result);
    if (!Array.isArray(payload)) {
      return [];
    }

    const sessions: HostSessionInfo[] = [];
    for (const item of payload) {
      const session = asRecord(item);
      const id = asTrimmedString(session?.id);
      if (!id) {
        continue;
      }
      const projected = {
        id,
        ...(asTrimmedString(session?.title) ? { title: asTrimmedString(session?.title) } : {}),
        ...(asTrimmedString(session?.projectID) ? { projectID: asTrimmedString(session?.projectID) } : {}),
        ...(asTrimmedString(session?.workspaceID) ? { workspaceID: asTrimmedString(session?.workspaceID) } : {}),
        ...(asTrimmedString(session?.directory) ? { directory: asTrimmedString(session?.directory) } : {}),
      };
      if (scope.projectID && projected.projectID !== scope.projectID) {
        continue;
      }
      if (scope.workspaceID && projected.workspaceID !== scope.workspaceID) {
        continue;
      }
      sessions.push(projected);
    }
    return sessions;
  }

  /** 控制面模型目录入口：兼容不同 SDK 宿主返回 shape。 */
  private async listControlPlaneModels(): Promise<HostModelInfo[]> {
    const client = this.requireSdkClient();
    const providersResult = await client.config.providers();
    const payload = this.unwrapSdkData(providersResult);
    const providers = Array.isArray(payload)
      ? payload
      : Array.isArray(asRecord(payload)?.providers)
        ? (asRecord(payload)?.providers as unknown[])
        : [];

    return providers.flatMap((provider) => {
      const providerRecord = asRecord(provider);
      const providerId =
        asTrimmedString(providerRecord?.id)
        ?? asTrimmedString(providerRecord?.providerID)
        ?? asTrimmedString(providerRecord?.name);
      if (!providerId) {
        return [];
      }
      const modelCatalog = asRecord(providerRecord?.models);
      const models = modelCatalog ? Object.values(modelCatalog) : [];
      return models.flatMap((model) => {
        const modelRecord = asRecord(model);
        const modelId =
          asTrimmedString(modelRecord?.id)
          ?? asTrimmedString(modelRecord?.modelID)
          ?? asTrimmedString(modelRecord?.name);
        if (!modelId) {
          return [];
        }
        return [{
          providerId,
          modelId,
          label: asTrimmedString(modelRecord?.label),
        }];
      });
    });
  }

  /** 控制面 prompt 执行入口：把 ActionResult 失败抬升为统一异常对象，供 runtime 统一回错。 */
  private async promptControlPlaneSession(input: {
    sessionId: string;
    text: string;
    assistantId?: string;
    modelOverride?: { providerId: string; modelId: string };
    logger?: BridgeLogger;
  }): Promise<void> {
    const result = await this.opencodeSessionGatewayAdapter.promptSession({
      sessionId: input.sessionId,
      text: input.text,
      agent: input.assistantId,
      modelOverride: input.modelOverride,
      logger: input.logger,
    });
    if (!result.success) {
      throw this.toControlPlaneError(result);
    }
  }

  /** 控制面上送只负责投影和发送，不复用普通 chat 的 ToolDoneCompat。 */
  private sendControlPlaneMessage(message: Record<string, unknown>): boolean {
    const connection = this.getActiveGatewayConnection();
    if (!connection) {
      this.logger.warn('runtime.control_plane_send.skipped_no_connection', {
        messageType: typeof message?.type === 'string' ? message.type : undefined,
      });
      return false;
    }
    const payload = message as GatewaySendPayload;
    const toolSessionId =
      'toolSessionId' in payload && typeof payload.toolSessionId === 'string'
        ? payload.toolSessionId
        : undefined;
    const validated = this.validateGatewayUplinkBusinessMessageOrLog(
      payload,
      {
        traceId: this.logger.getTraceId(),
        runtimeTraceId: this.logger.getTraceId(),
        toolSessionId,
        eventType: payload.type === 'tool_event' && typeof payload.event?.type === 'string'
          ? payload.event.type
          : undefined,
      },
      this.logger,
    );
    if (!validated) {
      return false;
    }
    return this.sessionSender.sendIfActive(connection, validated, {
      traceId: this.logger.getTraceId(),
      runtimeTraceId: this.logger.getTraceId(),
      toolSessionId,
      eventType: payload.type === 'tool_event' && typeof payload.event?.type === 'string'
        ? payload.event.type
        : undefined,
    });
  }

  /** 控制面错误转成 runtime 可用的 ActionFailure 结构。 */
  private toControlPlaneActionFailure(error: unknown): ActionFailure {
    if (
      typeof error === 'object'
      && error !== null
      && 'errorCode' in error
      && 'errorMessage' in error
    ) {
      return {
        success: false,
        errorCode: this.normalizeControlPlaneErrorCode((error as { errorCode?: string }).errorCode),
        errorMessage: (error as { errorMessage?: string }).errorMessage ?? 'Control plane failed',
        errorEvidence: 'errorEvidence' in error
          ? (error as { errorEvidence?: ActionFailure['errorEvidence'] }).errorEvidence
          : undefined,
      };
    }

    return {
      success: false,
      errorCode: 'SDK_UNREACHABLE',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  /** 宿主会话缺失时，同步失效 binding 与 ownership，避免后续事件串线。 */
  private handleControlPlanePromptFailure(anchor: string, error: unknown): void {
    const actionFailure = this.toControlPlaneActionFailure(error);
    const sourceErrorCode = actionFailure.errorEvidence?.sourceErrorCode;
    const sourceOperation = actionFailure.errorEvidence?.sourceOperation;
    if (sourceErrorCode !== 'session_not_found' && sourceOperation !== 'session.get') {
      return;
    }

    const binding = this.bindingStore.get(anchor);
    if (!binding) {
      return;
    }
    this.bindingStore.invalidate(anchor);
    this.ownershipResolver.detach(binding.activeOpencodeSessionId);
  }

  /** 把现有 adapter 的 ActionResult 失败抬升为统一控制面错误对象。 */
  private toControlPlaneError(result: ActionFailure): {
    errorCode: string;
    errorMessage: string;
    errorEvidence?: ActionFailure['errorEvidence'];
  } {
    return {
      errorCode: result.errorCode ?? 'SDK_UNREACHABLE',
      errorMessage: result.errorMessage ?? 'Control plane failed',
      errorEvidence: result.errorEvidence,
    };
  }

  private normalizeControlPlaneErrorCode(errorCode?: string): ActionFailure['errorCode'] {
    switch (errorCode) {
      case 'GATEWAY_UNREACHABLE':
      case 'SDK_TIMEOUT':
      case 'SDK_UNREACHABLE':
      case 'AGENT_NOT_READY':
      case 'INVALID_PAYLOAD':
      case 'UNSUPPORTED_ACTION':
        return errorCode;
      default:
        return 'SDK_UNREACHABLE';
    }
  }

  private requireSdkClient(): BridgeSdkClient {
    if (!this.sdkClient) {
      throw new Error('runtime.sdk_client_unavailable');
    }
    return this.sdkClient;
  }

  private unwrapSdkData(result: unknown): unknown {
    const record = asRecord(result);
    if (record?.error !== undefined) {
      throw record.error;
    }
    if ('data' in (record ?? {})) {
      return record?.data;
    }
    return result;
  }

  private async validateStartupPrerequisites() {
    try {
      return await validateBridgeStartup(this.rawClient, this.sdkClient, this.missingSdkCapabilities);
    } catch (error) {
      if (isBridgeStartupError(error)) {
        this.logStartupFailure(error);
      }
      throw error;
    }
  }

  private logStartupFailure(error: BridgeStartupError): void {
    const payload = {
      errorCode: error.code,
      errorMessage: error.message,
      ...error.details,
    };

    if (error.code === 'SDK_CLIENT_CAPABILITIES_MISSING') {
      this.logger.error('runtime.start.failed_capabilities', payload);
      return;
    }

    if (error.code === 'GLOBAL_HEALTH_VERSION_MISSING') {
      this.logger.error('runtime.start.failed_health_version', payload);
      return;
    }

    this.logger.error('runtime.start.failed_health', payload);
  }

  private buildEventLogFields(normalized: NormalizedUpstreamEvent): EventLogFields {
    return this.buildEventForwardingDetail(normalized);
  }

  private logEventForwardingDetail(normalized: NormalizedUpstreamEvent, logger: BridgeLogger = this.logger): void {
    const detail = this.buildEventForwardingDetail(normalized);
    logger.debug('event.forwarding.detail', detail as unknown as Record<string, unknown>);
  }

  private buildEventForwardingDetail(normalized: NormalizedUpstreamEvent): EventLogFields {
    const extra = normalized.extra;
    const raw = normalized.raw as {
      properties?: {
        delta?: unknown;
        part?: { type?: unknown; callID?: unknown };
      };
    };
    return {
      eventType: normalized.common.eventType,
      toolSessionId: normalized.common.toolSessionId,
      opencodeMessageId: this.getMessageId(extra) ?? undefined,
      opencodePartId: this.getPartId(extra) ?? undefined,
      role: this.getRole(extra),
      status: this.getStatus(extra),
      partType: typeof raw.properties?.part?.type === 'string' ? raw.properties.part.type : null,
      toolCallId: typeof raw.properties?.part?.callID === 'string' ? raw.properties.part.callID : undefined,
      deltaBytes: typeof raw.properties?.delta === 'string' ? Buffer.byteLength(raw.properties.delta, 'utf8') : null,
    };
  }

  private getMessageId(extra: NormalizedUpstreamEvent['extra']): string | null {
    if (!extra) {
      return null;
    }
    if (
      extra.kind === TOOL_EVENT_TYPE.MESSAGE_UPDATED ||
      extra.kind === TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED ||
      extra.kind === TOOL_EVENT_TYPE.MESSAGE_PART_DELTA ||
      extra.kind === TOOL_EVENT_TYPE.MESSAGE_PART_REMOVED
    ) {
      return extra.messageId;
    }
    return null;
  }

  private getPartId(extra: NormalizedUpstreamEvent['extra']): string | null {
    if (!extra) {
      return null;
    }
    if (
      extra.kind === TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED ||
      extra.kind === TOOL_EVENT_TYPE.MESSAGE_PART_DELTA ||
      extra.kind === TOOL_EVENT_TYPE.MESSAGE_PART_REMOVED
    ) {
      return extra.partId;
    }
    return null;
  }

  private getRole(extra: NormalizedUpstreamEvent['extra']): string | null {
    return extra && extra.kind === TOOL_EVENT_TYPE.MESSAGE_UPDATED ? extra.role : null;
  }

  private getStatus(extra: NormalizedUpstreamEvent['extra']): string | null {
    return extra && extra.kind === TOOL_EVENT_TYPE.SESSION_STATUS ? extra.status : null;
  }

  private extractDownstreamLogFields(raw: unknown): DownstreamLogFields {
    const message = asRecord(raw);
    if (!message) {
      return {};
    }
    const payload = asRecord(message.payload);

    return {
      messageType: asString(message.type),
      gatewayMessageId: asString(message.messageId),
      action: asString(message.action),
      welinkSessionId: asString(message.welinkSessionId),
      toolSessionId: asString(payload?.toolSessionId),
    };
  }

  private createMessageLogger(
    baseFields: EventLogFields | DownstreamLogFields | Record<string, unknown>,
    traceId: string,
  ): BridgeLogger {
    const baseLogger = this.logger.child(baseFields as Record<string, unknown>);
    const withTrace = (method: 'debug' | 'info' | 'warn' | 'error') =>
      (message: string, extra?: Record<string, unknown>) => baseLogger[method](message, { traceId, ...(extra ?? {}) });

    return {
      debug: withTrace('debug'),
      info: withTrace('info'),
      warn: withTrace('warn'),
      error: withTrace('error'),
      child: (extra: Record<string, unknown>) => this.createMessageLogger({ ...baseFields, ...extra }, traceId),
      getTraceId: () => traceId,
    };
  }

  private getActiveGatewayConnection(): GatewayClient | null {
    return this.gatewayConnectionOverride ?? this.lifecycleCoordinator.getActiveConnection();
  }

  /**
   * runtime 到 gateway 生命周期协调器的适配端口。
   * @remarks 这里只桥接状态发布与事件上抛，避免 coordinator 反向持有业务依赖。
   */
  private createGatewayLifecyclePort(): GatewayLifecyclePort {
    return {
      publishState: (state) => {
        this.statusAdapter.publishGatewayState(state);
      },
      publishError: (error) => {
        this.statusAdapter.publishGatewayError(error);
      },
      handleInbound: (frame) => {
        this.handleInboundFrame(frame);
      },
      handleMessage: (message) => {
        const messageType =
          message && typeof message === 'object' && 'type' in (message as { type?: unknown })
            ? String((message as { type?: unknown }).type ?? '')
            : 'unknown';
        this.logger.debug('gateway.message.received', { messageType });
        this.handleDownstreamMessage(message).catch((error) => {
          this.logger.error('runtime.downstream_message_error', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      log: (level, message, meta) => {
        this.logger[level](message, meta);
      },
    };
  }

  private sendToolError(
    result: ActionResult,
    welinkSessionId?: string,
    logOptions?: {
      connection?: GatewayClient | null;
      logger?: BridgeLogger;
      traceId?: string;
      gatewayMessageId?: string;
      action?: string;
      toolSessionId?: string;
    },
  ): void {
    const connection = logOptions?.connection ?? this.getActiveGatewayConnection();
    if (!connection) {
      this.logger.warn('runtime.tool_error.skipped_no_connection', { welinkSessionId });
      return;
    }

    const error = result.success ? 'Unknown error' : result.errorMessage ?? 'Unknown error';
    const reason = this.toolErrorClassifier.classify(result, logOptions?.action);
    const logger = logOptions?.logger ?? this.logger;
    logger.error('runtime.tool_error.sending', {
      welinkSessionId,
      error,
      reason,
      sourceErrorCode: result.success ? undefined : result.errorEvidence?.sourceErrorCode,
    });

    const toolErrorMessage: GatewaySendPayload = {
      type: UPSTREAM_MESSAGE_TYPE.TOOL_ERROR,
      welinkSessionId,
      toolSessionId: logOptions?.toolSessionId,
      error,
      reason,
    };
    const toolErrorLogContext: GatewaySendLogContext = {
      traceId: logOptions?.traceId,
      runtimeTraceId: this.logger.getTraceId(),
      gatewayMessageId: logOptions?.gatewayMessageId,
      welinkSessionId,
      action: logOptions?.action,
      toolSessionId: logOptions?.toolSessionId,
    };
    const validatedToolError = this.validateGatewayUplinkBusinessMessageOrLog(
      toolErrorMessage,
      toolErrorLogContext,
      logger,
    );
    if (!validatedToolError) {
      return;
    }
    this.sessionSender.sendIfActive(connection, validatedToolError, toolErrorLogContext);
  }

  private sendToolDone(
    toolSessionId: string,
    welinkSessionId: string | undefined,
    source: RuntimeToolDoneSource,
    logOptions?: {
      connection?: GatewayClient | null;
      logger?: BridgeLogger;
      traceId?: string;
      gatewayMessageId?: string;
      action?: string;
    },
  ): boolean {
    // todo connection判断
    const connection = logOptions?.connection ?? this.getActiveGatewayConnection();
    if (!connection) {
      this.logger.warn('runtime.tool_done.skipped_no_connection', { toolSessionId, welinkSessionId, source });
      return false;
    }

    const logger = logOptions?.logger ?? this.logger;
    logger.info('runtime.tool_done.sending', {
      toolSessionId,
      welinkSessionId,
      source,
      action: logOptions?.action,
    });

    const toolDoneMessage: GatewaySendPayload = {
      type: UPSTREAM_MESSAGE_TYPE.TOOL_DONE,
      toolSessionId,
      welinkSessionId,
    };
    const toolDoneLogContext: GatewaySendLogContext = {
      traceId: logOptions?.traceId,
      runtimeTraceId: this.logger.getTraceId(),
      gatewayMessageId: logOptions?.gatewayMessageId,
      welinkSessionId,
      action: logOptions?.action,
      toolSessionId,
      source,
    };
    const validatedToolDone = this.validateGatewayUplinkBusinessMessageOrLog(
      toolDoneMessage,
      toolDoneLogContext,
      logger,
    );
    if (!validatedToolDone) {
      return false;
    }
    return this.sessionSender.sendIfActive(connection, validatedToolDone, toolDoneLogContext);
  }

  private validateGatewayUplinkBusinessMessageOrLog(
    message: GatewaySendPayload,
    logContext: GatewaySendLogContext,
    logger: BridgeLogger = this.logger,
  ): GatewaySendPayload | null {
    // 运行时最终准入点：只有通过共享 wire 校验的消息才允许真正发往 gateway。
    const validation = validateGatewayUplinkBusinessMessage(message);
    if (validation.ok) {
      return validation.value as GatewaySendPayload;
    }
    const violation = validation.error.violation;

    logger.error('runtime.upstream_validation_failed', {
      gatewayMessageId: logContext.gatewayMessageId,
      welinkSessionId: logContext.welinkSessionId,
      toolSessionId: logContext.toolSessionId,
      action: logContext.action,
      eventType: violation.eventType ?? logContext.eventType,
      messageType: message.type,
      stage: violation.stage,
      errorCode: violation.code,
      field: violation.field,
      errorMessage: violation.message,
    });
    return null;
  }
}
