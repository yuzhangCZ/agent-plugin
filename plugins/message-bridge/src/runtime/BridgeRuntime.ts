import { randomUUID } from 'crypto';
import os from 'os';
import {
  ActionResult,
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
  buildGatewayRegisterMessage,
  createAkSkAuthProvider,
  createGatewayClient,
  type GatewayBusinessMessage,
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
import { SubagentSessionMapper } from '../session/SubagentSessionMapper.js';
import { resolvePluginVersion } from './pluginVersion.js';
import { resolveRegisterMetadata } from './RegisterMetadata.js';
import { warnUnknownToolType } from './ToolTypeWarning.js';
import { isBridgeStartupError, type BridgeStartupError, validateBridgeStartup } from './Startup.js';
import {
  DefaultUpstreamTransportProjector,
  type UpstreamTransportProjector,
} from '../transport/upstream/index.js';
import type { HostClientLike, OpencodeClient } from '../types/index.js';
import { getErrorDetailsForLog } from '../utils/error.js';
import { asRecord, asString, asTrimmedString } from '../utils/type-guards.js';

export interface BridgeRuntimeOptions {
  workspacePath?: string;
  hostDirectory?: string;
  client: unknown;
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

function withOpencodeFamily<T extends object>(event: T): T & { family: 'opencode' } {
  return {
    ...event,
    family: 'opencode',
  };
}

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

  private gatewayConnection: GatewayClient | null = null;
  private eventFilter: EventFilter | null = null;
  private started = false;
  private readonly rawClient: HostClientLike;
  private sdkClient: OpencodeClient | null;
  private readonly missingSdkCapabilities: ReturnType<typeof getMissingSdkCapabilities>;
  private readonly workspacePath?: string;
  private readonly hostDirectory?: string;
  private effectiveDirectory?: string;
  private logger: BridgeLogger;
  private readonly toolDoneCompat = new ToolDoneCompat();
  private readonly toolErrorClassifier = new ToolErrorClassifier();
  private readonly invalidInvokeToolErrorResponder: InvalidInvokeToolErrorResponder;
  private readonly subagentSessionMapper = new SubagentSessionMapper(() => this.sdkClient);
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
    this.logger = new AppLogger(this.rawClient, { component: 'runtime' });
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
    this.invalidInvokeToolErrorResponder = new InvalidInvokeToolErrorResponder({
      sendToolError: (result, welinkSessionId, logOptions) => this.sendToolError(result, welinkSessionId, logOptions),
      canReply: () => this.gatewayConnection?.getStatus().isReady() ?? false,
      getConnectionState: () => this.gatewayConnection?.getState(),
    });
    this.registerActions();
    this.actionRouter.setRegistry(this.registry);
  }

  protected async resolveConfig() {
    return loadConfig(this.workspacePath, this.logger);
  }

  protected createGatewayConnection(options: GatewayClientConfig): GatewayClient {
    return createGatewayClient(options);
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('runtime.config.loading_failed', {
        error: errorMessage,
        workspacePath: this.workspacePath,
      });
      throw error;
    }
    if (!config.enabled) {
      this.logger.info('runtime.start.disabled_by_config');
      this.started = true;
      return;
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

    const startupValidation = await this.validateStartupPrerequisites();
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

    connection.on('stateChange', (state) => {
      this.logger.info('gateway.state.changed', { state });
    });

    connection.on('inbound', (frame) => {
      this.handleInboundFrame(frame as GatewayInboundFrame);
    });

    connection.on('message', (message) => {
      const messageType =
        message && typeof message === 'object' && 'type' in (message as { type?: unknown })
          ? String((message as { type?: unknown }).type ?? '')
          : 'unknown';
      this.logger.debug('gateway.message.received', { messageType });
      this.handleDownstreamMessage(message as GatewayBusinessMessage).catch((error) => {
        this.logger.error('runtime.downstream_message_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    this.gatewayConnection = connection;
    if (options.abortSignal?.aborted) {
      this.gatewayConnection.disconnect();
      this.gatewayConnection = null;
      this.logger.warn('runtime.start.aborted_before_connect');
      throw new Error('runtime_start_aborted');
    }

    await connection.connect();
    if (options.abortSignal?.aborted) {
      this.gatewayConnection.disconnect();
      this.gatewayConnection = null;
      this.logger.warn('runtime.start.aborted_after_connect');
      throw new Error('runtime_start_aborted');
    }

    this.started = true;
    this.logger.info('runtime.start.completed');
  }

  stop(): void {
    this.logger.info('runtime.stop.requested');
    if (this.gatewayConnection) {
      this.gatewayConnection.disconnect();
      this.gatewayConnection = null;
    }

    this.started = false;
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

    const connection = this.gatewayConnection;
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
    const envelopeToolSessionId = subagentMapping?.parentSessionId ?? normalized.common.toolSessionId;
    const subagentEnvelopeFields = subagentMapping
      ? {
          subagentSessionId: subagentMapping.childSessionId,
          subagentName: subagentMapping.agentName,
        }
      : {};
    forwardingLogger.info('event.forwarding');
    const transportEvent = this.upstreamTransportProjector.project(normalized);
    const rawEvent = withOpencodeFamily(normalized.raw);
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
    connection.send(validatedEnvelope, transportLogContext);
    forwardingLogger.debug('event.forwarded');

    // child session 的 idle 仅代表子代理收尾，不能向 parent 额外补发 tool_done。
    if (normalized.common.eventType === TOOL_EVENT_TYPE.SESSION_IDLE && !subagentMapping) {
      const decision = this.toolDoneCompat.handleSessionIdle({
        toolSessionId: normalized.common.toolSessionId,
        logger: forwardingLogger,
      });
      if (decision.emit && decision.source) {
        this.sendToolDone(normalized.common.toolSessionId, undefined, decision.source, {
          logger: forwardingLogger,
          traceId: bridgeMessageId,
          gatewayMessageId: bridgeMessageId,
        });
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
    if (!this.gatewayConnection) {
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
        this.buildActionContext(this.gatewayConnection, undefined, statusLogger),
      );
      if (!result.success) {
        this.sendToolError(result, undefined, {
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
      this.gatewayConnection.send(validatedStatusResponse, statusLogContext);
      statusLogger.info('runtime.status_query.responded', {
        latencyMs: Date.now() - startedAt,
      });
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

    if (!this.gatewayConnection.getStatus().isReady()) {
      invokeLogger.warn('runtime.invoke.ignored_not_ready', {
        state: this.gatewayConnection.getState(),
      });
      return;
    }

    invokeLogger.info('runtime.invoke.received');

    if (invokeMessage.action === 'create_session') {
      const normalizedWelinkSessionId = asTrimmedString(invokeMessage.welinkSessionId) ?? invokeMessage.welinkSessionId;
      const result = await this.actionRouter.route(
        invokeMessage.action,
        invokeMessage.payload,
        this.buildActionContext(this.gatewayConnection, normalizedWelinkSessionId, invokeLogger),
      );

      if (!result.success) {
        this.sendToolError(result, welinkSessionId, {
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
            logger: invokeLogger,
            traceId,
            gatewayMessageId: downstreamFields.gatewayMessageId,
            action: invokeMessage.action,
          },
        );
        return;
      }

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
      this.gatewayConnection.send(validatedSessionCreated, sessionCreatedLogContext);
      invokeLogger.info('runtime.invoke.completed', {
        action: invokeMessage.action,
        welinkSessionId: normalizedWelinkSessionId,
        toolSessionId,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    this.toolDoneCompat.handleInvokeStarted({
      action: invokeMessage.action,
      toolSessionId,
    });
    const result = await this.actionRouter.route(
      invokeMessage.action,
      invokeMessage.payload,
      this.buildActionContext(this.gatewayConnection, welinkSessionId, invokeLogger),
    );

    if (!result.success) {
      this.toolDoneCompat.handleInvokeFailed({
        action: invokeMessage.action,
        toolSessionId,
      });
      this.sendToolError(result, welinkSessionId, {
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
      this.sendToolDone(toolSessionId, welinkSessionId, decision.source, {
        logger: invokeLogger,
        traceId,
        gatewayMessageId: downstreamFields.gatewayMessageId,
        action: invokeMessage.action,
      });
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

  private sendToolError(
    result: ActionResult,
    welinkSessionId?: string,
    logOptions?: {
      logger?: BridgeLogger;
      traceId?: string;
      gatewayMessageId?: string;
      action?: string;
      toolSessionId?: string;
    },
  ): void {
    if (!this.gatewayConnection) {
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
    this.gatewayConnection.send(validatedToolError, toolErrorLogContext);
  }

  private sendToolDone(
    toolSessionId: string,
    welinkSessionId: string | undefined,
    source: ToolDoneSource,
    logOptions?: {
      logger?: BridgeLogger;
      traceId?: string;
      gatewayMessageId?: string;
      action?: string;
    },
  ): void {
    if (!this.gatewayConnection) {
      this.logger.warn('runtime.tool_done.skipped_no_connection', { toolSessionId, welinkSessionId, source });
      return;
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
      return;
    }
    this.gatewayConnection.send(validatedToolDone, toolDoneLogContext);
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
