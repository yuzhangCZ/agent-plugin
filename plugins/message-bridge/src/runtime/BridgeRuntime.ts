import { randomUUID } from 'crypto';
import os from 'os';
import {
  ActionResult,
  StatusQueryPayload,
  StatusQueryResultData,
} from '../types/index.js';
import { ToolErrorClassifier } from '../error/ToolErrorClassifier.js';
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
import { loadConfig } from '../config/index.js';
import { DefaultAkSkAuth } from '../connection/AkSkAuth.js';
import { DefaultGatewayConnection, GatewayConnection } from '../connection/GatewayConnection.js';
import { DefaultReconnectPolicy, ReconnectPolicy } from '../connection/ReconnectPolicy.js';
import { DefaultStateManager } from '../connection/StateManager.js';
import { EventFilter } from '../event/EventFilter.js';
import {
  extractUpstreamEvent,
  type MessagePartExtra,
  type MessageUpdatedExtra,
  type NormalizedUpstreamEvent,
  type SessionStatusExtra,
} from '../protocol/upstream/index.js';
import {
  normalizeDownstreamMessage,
} from '../protocol/downstream/index.js';
import { ChatUseCase, CreateSessionUseCase, ResolveCreateSessionDirectoryUseCase } from '../usecase/index.js';
import { BridgeEvent } from './types.js';
import { createSdkAdapter, getMissingSdkCapabilities, toHostClientLike } from './SdkAdapter.js';
import { AppLogger, type BridgeLogger } from './AppLogger.js';
import { ToolDoneCompat, type ToolDoneSource } from './compat/ToolDoneCompat.js';
import { resolvePluginVersion } from './pluginVersion.js';
import { resolveRegisterMetadata } from './RegisterMetadata.js';
import { warnUnknownToolType } from './ToolTypeWarning.js';
import { isBridgeStartupError, type BridgeStartupError, validateBridgeStartup } from './Startup.js';
import {
  DefaultUpstreamTransportProjector,
  type UpstreamTransportProjector,
} from '../transport/upstream/index.js';
import type { HostClientLike, OpencodeClient } from '../types/index.js';
import type { ReconnectConfig } from '../types/index.js';

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

export class BridgeRuntime {
  private readonly actionRouter = new DefaultActionRouter();
  private readonly stateManager = new DefaultStateManager();
  private readonly registry = new DefaultActionRegistry();
  private readonly upstreamTransportProjector: UpstreamTransportProjector = new DefaultUpstreamTransportProjector();
  private readonly bridgeChannelPort: EnvBridgeChannelAdapter;
  private readonly assiantDirectoryMappingPort: JsonAssiantDirectoryMappingAdapter;
  private readonly opencodeSessionGatewayAdapter: OpencodeSessionGatewayAdapter;
  private readonly resolveCreateSessionDirectoryUseCase: ResolveCreateSessionDirectoryUseCase;
  private readonly createSessionUseCase: CreateSessionUseCase;
  private readonly chatUseCase: ChatUseCase;

  private gatewayConnection: GatewayConnection | null = null;
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
    this.opencodeSessionGatewayAdapter = new OpencodeSessionGatewayAdapter(() => this.sdkClient);
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
    this.registerActions();
    this.actionRouter.setRegistry(this.registry);
  }

  protected async resolveConfig() {
    return loadConfig(this.workspacePath, this.logger);
  }

  protected createReconnectPolicy(reconnect: ReconnectConfig): ReconnectPolicy {
    return new DefaultReconnectPolicy(reconnect);
  }

  protected createGatewayConnection(options: ConstructorParameters<typeof DefaultGatewayConnection>[0]): GatewayConnection {
    return new DefaultGatewayConnection(options);
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
    this.logger.info('runtime.directory.resolved', {
      workspacePath: this.workspacePath,
      hostDirectory: this.hostDirectory,
      effectiveDirectory: this.effectiveDirectory,
      directorySource: config.bridgeDirectory ? 'env' : this.hostDirectory ? 'host_input' : 'none',
    });

    const startupValidation = await this.validateStartupPrerequisites();
    this.sdkClient = startupValidation.sdkClient;
    const agentId = this.stateManager.generateAndBindAgentId();
    this.eventFilter = new EventFilter(config.events.allowlist);
    const registerMetadata = resolveRegisterMetadata(startupValidation.health.version, this.logger);
    warnUnknownToolType(this.logger, 'runtime.register.tool_type.unknown', config.gateway.channel, {
      workspacePath: this.workspacePath,
    });

    const auth = new DefaultAkSkAuth(config.auth.ak, config.auth.sk);
    const authPayloadProvider = () => auth.generateAuthPayload();
    const reconnectPolicy = this.createReconnectPolicy(config.gateway.reconnect);

    const connection = this.createGatewayConnection({
      url: config.gateway.url,
      debug: effectiveDebug,
      reconnect: config.gateway.reconnect,
      reconnectPolicy,
      heartbeatIntervalMs: config.gateway.heartbeatIntervalMs,
      abortSignal: options.abortSignal,
      authPayloadProvider,
      registerMessage: {
        type: 'register',
        deviceName: registerMetadata.deviceName,
        macAddress: registerMetadata.macAddress,
        os: os.platform(),
        toolType: config.gateway.channel,
        toolVersion: registerMetadata.toolVersion,
      },
      logger: this.logger.child({ component: 'gateway' }),
    });

    connection.on('stateChange', (state) => {
      this.stateManager.setState(state);
      this.logger.info('gateway.state.changed', { state });
      if (state === 'CONNECTING') {
        const nextAgentId = this.stateManager.resetForReconnect();
        this.logger.info('runtime.agent.rebound', { agentId: nextAgentId });
      }
    });

    connection.on('message', (message) => {
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
    this.logger.info('runtime.start.completed', { agentId: this.stateManager.getAgentId() });
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

  async handleEvent(event: BridgeEvent): Promise<void> {
    const extraction = extractUpstreamEvent(event, this.logger);
    if (!extraction.ok) {
      return;
    }

    const normalized = extraction.value;
    const eventFields = this.buildEventLogFields(normalized);
    const eventTraceId = eventFields.opencodeMessageId ?? this.logger.getTraceId();
    const eventLogger = this.createMessageLogger(eventFields, eventTraceId);
    eventLogger.debug('event.received');

    if (!this.stateManager.isReady() || !this.gatewayConnection || !this.eventFilter) {
      eventLogger.debug('event.ignored_not_ready', {
        state: this.stateManager.getState(),
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
    forwardingLogger.info('event.forwarding');
    const transportEvent = this.upstreamTransportProjector.project(normalized);
    const transportEnvelope = {
      type: 'tool_event',
      toolSessionId: normalized.common.toolSessionId,
      event: transportEvent,
    };
    const originalEnvelope = {
      type: 'tool_event',
      toolSessionId: normalized.common.toolSessionId,
      event: normalized.raw,
    };
    this.gatewayConnection.send(transportEnvelope, {
      traceId: bridgeMessageId,
      runtimeTraceId: this.logger.getTraceId(),
      gatewayMessageId: bridgeMessageId,
      toolSessionId: normalized.common.toolSessionId,
      eventType: normalized.common.eventType,
      opencodeMessageId: eventFields.opencodeMessageId,
      opencodePartId: eventFields.opencodePartId,
      toolCallId: eventFields.toolCallId ?? undefined,
      originalPayloadBytes: Buffer.byteLength(JSON.stringify(originalEnvelope), 'utf8'),
      transportPayloadBytes: Buffer.byteLength(JSON.stringify(transportEnvelope), 'utf8'),
    });
    forwardingLogger.debug('event.forwarded');

    if (normalized.common.eventType === 'session.idle') {
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

  private async handleDownstreamMessage(raw: unknown): Promise<void> {
    // Runtime orchestrates protocol flow but does not own raw schema parsing.
    if (!this.gatewayConnection) {
      this.logger.warn('runtime.downstream_ignored_no_connection');
      return;
    }
    const startedAt = Date.now();
    const downstreamFields = this.extractDownstreamLogFields(raw);
    const traceId = downstreamFields.gatewayMessageId ?? this.logger.getTraceId();
    const messageLogger = this.createMessageLogger(downstreamFields, traceId);
    const normalized = normalizeDownstreamMessage(raw, this.logger);
    if (!normalized.ok) {
      messageLogger.warn('runtime.downstream_ignored_non_protocol', {
        messageType: normalized.error.messageType ?? 'unknown',
        hasWelinkSessionId: !!normalized.error.welinkSessionId,
      });

      if (normalized.error.messageType === 'invoke') {
        const errorMessage =
          normalized.error.action === 'create_session' && normalized.error.field === 'welinkSessionId'
            ? normalized.error.message
            : 'Invalid invoke payload shape';
        this.sendToolError(
          { success: false, errorCode: 'INVALID_PAYLOAD', errorMessage: errorMessage },
          normalized.error.welinkSessionId,
          {
            logger: messageLogger,
            traceId,
            gatewayMessageId: downstreamFields.gatewayMessageId,
            action: downstreamFields.action,
            toolSessionId: downstreamFields.toolSessionId,
          },
        );
      }
      return;
    }
    const message = normalized.value;

    if (message.type === 'status_query') {
      const statusLogger = this.createMessageLogger(
        { ...downstreamFields },
        traceId,
      );
      statusLogger.info('runtime.status_query.received');
      const payload: StatusQueryPayload = {};
      const result = await this.actionRouter.route(
        'status_query',
        payload,
        this.buildActionContext(undefined, statusLogger),
      );
      if (!result.success) {
        this.sendToolError(result, undefined, {
          logger: statusLogger,
          traceId,
          gatewayMessageId: downstreamFields.gatewayMessageId,
          action: 'status_query',
        });
        return;
      }

      this.gatewayConnection.send({
        type: 'status_response',
        opencodeOnline: result.data.opencodeOnline,
      }, {
        traceId,
        runtimeTraceId: this.logger.getTraceId(),
        gatewayMessageId: downstreamFields.gatewayMessageId,
        action: 'status_query',
      });
      statusLogger.info('runtime.status_query.responded', {
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    const welinkSessionId = message.welinkSessionId;
    const toolSessionId =
      'payload' in message &&
      message.payload &&
      typeof message.payload === 'object' &&
      'toolSessionId' in message.payload &&
      typeof (message.payload as { toolSessionId?: unknown }).toolSessionId === 'string'
        ? (message.payload as { toolSessionId: string }).toolSessionId
        : undefined;
    const invokeLogger = this.createMessageLogger(
      {
        ...downstreamFields,
        welinkSessionId,
        action: message.action,
        toolSessionId,
      },
      traceId,
    );

    if (!this.stateManager.isReady()) {
      invokeLogger.warn('runtime.invoke.ignored_not_ready', {
        state: this.stateManager.getState(),
      });
      return;
    }

    invokeLogger.info('runtime.invoke.received');

    if (message.action === 'create_session') {
      if (!welinkSessionId) {
        invokeLogger.warn('runtime.create_session.missing_welink_session_id');
      }

      const result = await this.actionRouter.route(
        message.action,
        message.payload,
        this.buildActionContext(welinkSessionId, invokeLogger),
      );

      if (!result.success) {
        this.sendToolError(result, welinkSessionId, {
          logger: invokeLogger,
          traceId,
          gatewayMessageId: downstreamFields.gatewayMessageId,
          action: message.action,
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
            action: message.action,
          },
        );
        return;
      }

      this.gatewayConnection.send({
        type: 'session_created',
        welinkSessionId,
        toolSessionId,
        session: result.data,
      }, {
        traceId,
        runtimeTraceId: this.logger.getTraceId(),
        gatewayMessageId: downstreamFields.gatewayMessageId,
        welinkSessionId,
        toolSessionId,
        action: message.action,
      });
      invokeLogger.info('runtime.invoke.completed', {
        action: message.action,
        welinkSessionId,
        toolSessionId,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    this.toolDoneCompat.handleInvokeStarted({
      action: message.action,
      toolSessionId,
    });
    const result = await this.actionRouter.route(
      message.action,
      message.payload,
      this.buildActionContext(welinkSessionId, invokeLogger),
    );

    if (!result.success) {
      this.toolDoneCompat.handleInvokeFailed({
        action: message.action,
        toolSessionId,
      });
      this.sendToolError(result, welinkSessionId, {
        logger: invokeLogger,
        traceId,
        gatewayMessageId: downstreamFields.gatewayMessageId,
        action: message.action,
        toolSessionId,
      });
      return;
    }

    invokeLogger.info('runtime.invoke.completed', {
      action: message.action,
      welinkSessionId,
      toolSessionId,
      latencyMs: Date.now() - startedAt,
    });

    const decision = this.toolDoneCompat.handleInvokeCompleted({
      action: message.action,
      toolSessionId,
      logger: invokeLogger,
    });
    if (decision.emit && toolSessionId && decision.source) {
      this.sendToolDone(toolSessionId, welinkSessionId, decision.source, {
        logger: invokeLogger,
        traceId,
        gatewayMessageId: downstreamFields.gatewayMessageId,
        action: message.action,
      });
    }
  }

  private buildActionContext(welinkSessionId?: string, logger: BridgeLogger = this.logger) {
    if (!this.sdkClient) {
      throw new Error('runtime.sdk_client_unavailable');
    }

    return {
      client: this.sdkClient,
      hostClient: this.rawClient,
      connectionState: this.stateManager.getState(),
      agentId: this.stateManager.getAgentId() ?? 'unknown-agent',
      welinkSessionId,
      effectiveDirectory: this.effectiveDirectory,
      assiantDirectoryMappingConfigured: this.assiantDirectoryMappingPort.isConfigured(),
      logger: logger.child({
        component: 'action',
        agentId: this.stateManager.getAgentId() ?? 'unknown-agent',
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
    if (extra.kind === 'message.updated' || extra.kind === 'message.part.updated' || extra.kind === 'message.part.delta' || extra.kind === 'message.part.removed') {
      return extra.messageId;
    }
    return null;
  }

  private getPartId(extra: NormalizedUpstreamEvent['extra']): string | null {
    if (!extra) {
      return null;
    }
    if (extra.kind === 'message.part.updated' || extra.kind === 'message.part.delta' || extra.kind === 'message.part.removed') {
      return extra.partId;
    }
    return null;
  }

  private getRole(extra: NormalizedUpstreamEvent['extra']): string | null {
    return extra && extra.kind === 'message.updated' ? extra.role : null;
  }

  private getStatus(extra: NormalizedUpstreamEvent['extra']): string | null {
    return extra && extra.kind === 'session.status' ? extra.status : null;
  }

  private extractDownstreamLogFields(raw: unknown): DownstreamLogFields {
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    const message = raw as Record<string, unknown>;
    const payload = typeof message.payload === 'object' && message.payload ? (message.payload as Record<string, unknown>) : undefined;

    return {
      messageType: typeof message.type === 'string' ? message.type : undefined,
      gatewayMessageId: typeof message.messageId === 'string' ? message.messageId : undefined,
      action: typeof message.action === 'string' ? message.action : undefined,
      welinkSessionId: typeof message.welinkSessionId === 'string' ? message.welinkSessionId : undefined,
      toolSessionId: typeof payload?.toolSessionId === 'string' ? payload.toolSessionId : undefined,
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

    this.gatewayConnection.send({
      type: 'tool_error',
      welinkSessionId,
      toolSessionId: logOptions?.toolSessionId,
      error,
      reason,
    }, {
      traceId: logOptions?.traceId,
      runtimeTraceId: this.logger.getTraceId(),
      gatewayMessageId: logOptions?.gatewayMessageId,
      welinkSessionId,
      action: logOptions?.action,
      toolSessionId: logOptions?.toolSessionId,
    });
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

    this.gatewayConnection.send({
      type: 'tool_done',
      toolSessionId,
      welinkSessionId,
    }, {
      traceId: logOptions?.traceId,
      runtimeTraceId: this.logger.getTraceId(),
      gatewayMessageId: logOptions?.gatewayMessageId,
      welinkSessionId,
      action: logOptions?.action,
      toolSessionId,
      source,
    });
  }
}
