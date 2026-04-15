import { randomUUID } from "node:crypto";
import {
  createReplyPrefixOptions,
  normalizeOutboundReplyPayload,
  type OpenClawConfig,
  type PluginRuntime,
} from "openclaw/plugin-sdk";
import type { GatewayBusinessMessage, GatewayInboundFrame } from "@agent-plugin/gateway-client";
import type {
  DownstreamMessage,
  InvokeMessage,
} from "./gateway-wire/downstream.js";
import { DOWNSTREAM_MESSAGE_TYPE, INVOKE_ACTION } from "./gateway-wire/downstream.js";
import { normalizeLegacyCreateSessionPayload } from "./adapters/legacyCreateSessionAdapter.js";
import {
  MESSAGE_PART_FIELD,
  MESSAGE_PART_TYPE,
  SESSION_STATUS_TYPE,
  TOOL_EVENT_TYPE,
  TOOL_PART_STATUS,
  type GatewayMessagePartDeltaEvent,
  type GatewayMessagePartUpdatedEvent,
  type GatewayMessageUpdatedEvent,
  type GatewaySessionErrorEvent,
  type GatewaySessionIdleEvent,
  type GatewaySessionStatusEvent,
} from "./gateway-wire/tool-event.js";
import type {
  SessionCreatedMessage,
  StatusResponseMessage,
  ToolDoneMessage,
  ToolErrorMessage,
  ToolEventMessage,
  UpstreamMessage,
} from "./gateway-wire/transport.js";
import { TOOL_ERROR_REASON, UPSTREAM_MESSAGE_TYPE, validateUpstreamMessage } from "./gateway-wire/transport.js";
import {
  createGatewayClient,
  type GatewayClient,
} from "@agent-plugin/gateway-client";
import type { BridgeLogger, MessageBridgeResolvedAccount, MessageBridgeStatusSnapshot } from "./types.js";
import { reconcileFinalText } from "./reconcileFinalText.js";
import { resolveEffectiveReplyConfig, type StreamingSource } from "./resolveEffectiveReplyConfig.js";
import {
  resolveStreamingExecutionPlan,
  type ChatExecutionPath,
  type ChatExecutionPathReason,
  type StreamMode,
} from "./resolveStreamingExecutionPlan.js";
import { resolveRegisterMetadata, type RegisterMetadata, warnUnknownToolType } from "./runtime/RegisterMetadata.js";
import { markRuntimePhase, updateRuntimeSnapshot } from "./runtime/ConnectionCoordinator.js";
import { SessionRegistry } from "./session/SessionRegistry.js";
import { asRecord, asString, asTrimmedString } from "./utils/type-guards.js";
import { buildGatewayClientConfig } from "./gateway-client.js";
import { InvalidInvokeToolErrorResponder } from "./protocol/InvalidInvokeToolErrorResponder.js";

export interface OpenClawGatewayBridgeOptions {
  account: MessageBridgeResolvedAccount;
  config: OpenClawConfig;
  logger: BridgeLogger;
  runtime: PluginRuntime;
  setStatus: (status: MessageBridgeStatusSnapshot) => void;
  registerMetadata?: RegisterMetadata;
  connectionFactory?: (account: MessageBridgeResolvedAccount, logger: BridgeLogger) => GatewayClient;
}

type SubagentRuntime = PluginRuntime & {
  subagent: {
    run(params: {
      sessionKey: string;
      message: string;
      deliver: boolean;
      idempotencyKey: string;
    }): Promise<{ runId: string }>;
    waitForRun(params: { runId: string; timeoutMs: number }): Promise<{ status: string; error?: string }>;
    getSessionMessages(params: { sessionKey: string; limit: number }): Promise<{ messages: unknown[] }>;
    deleteSession(params: { sessionKey: string }): Promise<void>;
  };
};

function logDebug(logger: BridgeLogger, message: string, meta?: Record<string, unknown>): void {
  if (logger.debug) {
    logger.debug(message, meta);
    return;
  }
  logger.info(message, meta);
}

interface DownstreamLogFields {
  messageType?: string;
  action?: string;
  welinkSessionId?: string;
  toolSessionId?: string;
  gatewayMessageId?: string;
}

interface UpstreamSendContext {
  gatewayMessageId?: string;
  action?: string;
  welinkSessionId?: string;
  toolSessionId?: string;
}

function extractDownstreamLogFields(raw: unknown): DownstreamLogFields {
  const message = asRecord(raw);
  if (!message) {
    return {};
  }
  const payload = asRecord(message.payload);
  return {
    messageType: asTrimmedString(message.type),
    action: asTrimmedString(message.action),
    welinkSessionId: asTrimmedString(message.welinkSessionId),
    toolSessionId: asTrimmedString(payload?.toolSessionId),
    gatewayMessageId: asTrimmedString(message.messageId),
  };
}

function getInvokeToolSessionId(message: InvokeMessage): string | undefined {
  if ("toolSessionId" in message.payload) {
    return message.payload.toolSessionId;
  }
  return undefined;
}

function extractAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!asRecord(message) || message.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string") {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      const chunks = message.content
        .map((part) => {
          if (!asRecord(part)) {
            return "";
          }
          if (part.type === "text" && typeof part.text === "string") {
            return part.text;
          }
          if (typeof part.content === "string") {
            return part.content;
          }
          return "";
        })
        .filter(Boolean);
      if (chunks.length > 0) {
        return chunks.join("");
      }
    }
  }

  return "";
}

function buildBusyEvent(sessionKey: string): GatewaySessionStatusEvent {
  return {
    type: TOOL_EVENT_TYPE.SESSION_STATUS,
    properties: {
      sessionID: sessionKey,
      status: {
        type: SESSION_STATUS_TYPE.BUSY,
      },
    },
  };
}

function buildIdleEvent(sessionKey: string): GatewaySessionIdleEvent {
  return {
    type: TOOL_EVENT_TYPE.SESSION_IDLE,
    properties: {
      sessionID: sessionKey,
    },
  };
}

function buildSessionErrorEvent(sessionKey: string, error: string): GatewaySessionErrorEvent {
  return {
    type: TOOL_EVENT_TYPE.SESSION_ERROR,
    properties: {
      sessionID: sessionKey,
      error: {
        message: error,
      },
    },
  };
}

interface AssistantStreamState {
  messageId: string;
  partId: string;
  sessionKey: string;
  seeded: boolean;
  accumulatedText: string;
  chunkCount: number;
  firstChunkAt: number | null;
}

function createAssistantStreamState(sessionKey: string): AssistantStreamState {
  return {
    messageId: `msg_${randomUUID()}`,
    partId: `prt_${randomUUID()}`,
    sessionKey,
    seeded: false,
    accumulatedText: "",
    chunkCount: 0,
    firstChunkAt: null,
  };
}

interface ToolPartState {
  toolCallId: string;
  toolName: string;
  partId: string;
  messageId: string;
  sessionKey: string;
  status: (typeof TOOL_PART_STATUS)[keyof typeof TOOL_PART_STATUS];
  output?: string;
  error?: string;
  title?: string;
}

interface ToolAgentEvent {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: unknown;
}

type RetryAttempt = 0 | 1;

interface SelectedModelState {
  provider: string | null;
  model: string | null;
  thinkLevel: string | null;
}

function createSelectedModelState(): SelectedModelState {
  return {
    provider: null,
    model: null,
    thinkLevel: null,
  };
}

function buildAssistantMessageUpdated(sessionKey: string, messageId: string): GatewayMessageUpdatedEvent {
  return {
    type: TOOL_EVENT_TYPE.MESSAGE_UPDATED,
    properties: {
      info: {
        id: messageId,
        sessionID: sessionKey,
        role: "assistant",
        time: {
          created: Date.now(),
        },
      },
    },
  };
}

function buildAssistantPartUpdated(
  sessionKey: string,
  messageId: string,
  partId: string,
  text: string,
  delta?: string,
): GatewayMessagePartUpdatedEvent {
  return {
    type: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
    properties: {
      ...(delta !== undefined ? { delta } : {}),
      part: {
        id: partId,
        sessionID: sessionKey,
        messageID: messageId,
        type: MESSAGE_PART_TYPE.TEXT,
        text,
      },
    },
  };
}

function buildAssistantPartDelta(
  sessionKey: string,
  messageId: string,
  partId: string,
  delta: string,
): GatewayMessagePartDeltaEvent {
  return {
    type: TOOL_EVENT_TYPE.MESSAGE_PART_DELTA,
    properties: {
      sessionID: sessionKey,
      messageID: messageId,
      partID: partId,
      field: MESSAGE_PART_FIELD.TEXT,
      delta,
    },
  };
}

function buildToolPartUpdated(
  state: ToolPartState,
): GatewayMessagePartUpdatedEvent {
  return {
    type: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
    properties: {
      part: {
        id: state.partId,
        sessionID: state.sessionKey,
        messageID: state.messageId,
        type: MESSAGE_PART_TYPE.TOOL,
        tool: state.toolName,
        callID: state.toolCallId,
        state: {
          status: state.status,
          ...(state.output !== undefined ? { output: state.output } : {}),
          ...(state.error !== undefined ? { error: state.error } : {}),
          ...(state.title !== undefined ? { title: state.title } : {}),
        },
      },
    },
  };
}

function extractToolResultTitle(meta: unknown, toolName: string): string | undefined {
  if (!asRecord(meta)) {
    return undefined;
  }

  const summary = meta.summary;
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary;
  }

  const title = meta.title;
  if (typeof title === "string" && title.trim().length > 0) {
    return title;
  }

  return toolName;
}

export class OpenClawGatewayBridge {
  private readonly sessionRegistry: SessionRegistry;
  private readonly connection: GatewayClient;
  private readonly runtime: PluginRuntime;
  private readonly registerMetadata: RegisterMetadata;
  private readonly invalidInvokeToolErrorResponder: InvalidInvokeToolErrorResponder;
  private readonly activeToolSessions = new Map<
    string,
    {
      toolSessionId: string;
      runId: string | null;
      assistantStream: AssistantStreamState;
      toolStates: Map<string, ToolPartState>;
      pendingToolResultTarget: string | null;
    }
  >();
  private readonly activeRunToSessionKey = new Map<string, string>();
  private readonly terminatedToolSessionIds = new Set<string>();
  private readonly terminatedSessionKeys = new Set<string>();
  private running = false;
  private status: MessageBridgeStatusSnapshot;
  private unsubscribeAgentEvents: (() => boolean) | null = null;

  private publishStatus(): void {
    updateRuntimeSnapshot(this.options.account.accountId, { ...this.status });
    this.options.setStatus({ ...this.status });
  }

  constructor(private readonly options: OpenClawGatewayBridgeOptions) {
    this.runtime = options.runtime;
    this.registerMetadata = options.registerMetadata ?? resolveRegisterMetadata(options.logger);
    warnUnknownToolType(options.logger, this.registerMetadata.toolType, options.account.accountId);
    this.sessionRegistry = new SessionRegistry(`${options.account.agentIdPrefix}:${options.account.accountId}`);
    this.connection =
      options.connectionFactory?.(options.account, options.logger) ??
      createGatewayClient(buildGatewayClientConfig(options.account, options.logger, this.registerMetadata));
    this.invalidInvokeToolErrorResponder = new InvalidInvokeToolErrorResponder({
      sendToolError: (message, context) => this.sendToolError(message, context),
      canReply: () => {
        const status = this.connection.getStatus?.();
        return typeof status?.isReady === "function" ? status.isReady() : true;
      },
      getConnectionState: () => this.connection.getState?.(),
    });

    this.status = {
      accountId: options.account.accountId,
      running: false,
      connected: false,
      runtimePhase: "idle",
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      lastReadyAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastHeartbeatAt: null,
      probe: null,
      lastProbeAt: null,
    };

    this.connection.on("stateChange", (state) => {
      const now = Date.now();
      this.options.logger.info("gateway.state.changed", { state });
      this.status.connected = state === "CONNECTED" || state === "READY";
      if (state === "READY") {
        this.status.runtimePhase = "ready";
        markRuntimePhase(this.options.account.accountId, "ready");
      } else if (state === "CONNECTING" || state === "CONNECTED") {
        this.status.runtimePhase = "connecting";
        markRuntimePhase(this.options.account.accountId, "connecting");
      } else if (state === "DISCONNECTED") {
        this.status.runtimePhase = this.running ? "connecting" : "idle";
        markRuntimePhase(this.options.account.accountId, this.running ? "connecting" : "idle");
      }
      if (state === "READY") {
        this.status.lastReadyAt = now;
      }
      this.publishStatus();
    });
    this.connection.on("inbound", (frame) => {
      this.status.lastInboundAt = Date.now();
      this.publishStatus();
      this.handleInboundFrame(frame as GatewayInboundFrame);
    });
    this.connection.on("outbound", () => {
      this.status.lastOutboundAt = Date.now();
      this.publishStatus();
    });
    this.connection.on("heartbeat", () => {
      this.status.lastHeartbeatAt = Date.now();
      this.publishStatus();
    });
    this.connection.on("message", (message) => {
      this.handleDownstreamMessage(message as GatewayBusinessMessage).catch((error) => {
        this.options.logger.error("bridge.handle_downstream.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    this.connection.on("error", (error) => {
      this.status.lastError = error.message;
      this.publishStatus();
    });
  }

  async start(): Promise<void> {
    this.options.logger.info("runtime.start.requested", {
      accountId: this.options.account.accountId,
    });
    if (this.running) {
      this.options.logger.info("runtime.start.skipped_already_started", {
        accountId: this.options.account.accountId,
      });
      return;
    }
    this.running = true;
    this.status.running = true;
    this.status.runtimePhase = "connecting";
    this.status.lastStartAt = Date.now();
    markRuntimePhase(this.options.account.accountId, "connecting");
    this.publishStatus();
    if (!this.unsubscribeAgentEvents && this.runtime.events?.onAgentEvent) {
      this.unsubscribeAgentEvents = this.runtime.events.onAgentEvent((evt: ToolAgentEvent) => {
        this.handleRuntimeAgentEvent(evt);
      });
    }
    await this.connection.connect();
    this.options.logger.info("runtime.start.completed", {
      accountId: this.options.account.accountId,
    });
  }

  private getSubagentRuntime(): SubagentRuntime["subagent"] | null {
    return (this.runtime as Partial<SubagentRuntime>).subagent ?? null;
  }

  async stop(): Promise<void> {
    this.options.logger.info("runtime.stop.requested", {
      accountId: this.options.account.accountId,
    });
    if (!this.running) {
      this.options.logger.info("runtime.stop.skipped_not_running", {
        accountId: this.options.account.accountId,
      });
      return;
    }
    this.running = false;
    this.status.runtimePhase = "stopping";
    markRuntimePhase(this.options.account.accountId, "stopping");
    this.connection.disconnect();
    this.unsubscribeAgentEvents?.();
    this.unsubscribeAgentEvents = null;
    this.activeToolSessions.clear();
    this.activeRunToSessionKey.clear();
    this.status.running = false;
    this.status.connected = false;
    this.status.runtimePhase = "idle";
    this.status.lastStopAt = Date.now();
    markRuntimePhase(this.options.account.accountId, "idle");
    this.publishStatus();
    this.options.logger.info("runtime.stop.completed", {
      accountId: this.options.account.accountId,
    });
  }

  private handleInboundFrame(frame: GatewayInboundFrame): void {
    this.invalidInvokeToolErrorResponder.respond(frame, this.options.logger);
  }

  async handleDownstreamMessage(message: GatewayBusinessMessage): Promise<void> {
    if (!this.connection.isConnected()) {
      this.options.logger.warn("runtime.downstream_ignored_no_connection");
      return;
    }
    const startedAt = Date.now();
    const fields = extractDownstreamLogFields(message);
    logDebug(this.options.logger, "runtime.downstream.received", fields as Record<string, unknown>);
    const adapted = this.applyCompatAdapter(message);
    if (adapted.type === DOWNSTREAM_MESSAGE_TYPE.STATUS_QUERY) {
      this.options.logger.info("runtime.status_query.received", fields as Record<string, unknown>);
      const message: StatusResponseMessage = {
        type: UPSTREAM_MESSAGE_TYPE.STATUS_RESPONSE,
        opencodeOnline: this.running && this.connection.isConnected(),
      };
      const sent = this.sendValidatedUpstreamMessage(message, {
        gatewayMessageId: fields.gatewayMessageId,
        action: DOWNSTREAM_MESSAGE_TYPE.STATUS_QUERY,
      });
      if (!sent) {
        return;
      }
      this.options.logger.info("runtime.status_query.responded", {
        ...fields,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    this.options.logger.info("runtime.invoke.received", {
      ...fields,
      action: adapted.action,
      welinkSessionId: adapted.welinkSessionId,
      toolSessionId: getInvokeToolSessionId(adapted),
    });
    const invokeContext: UpstreamSendContext = {
      gatewayMessageId: fields.gatewayMessageId,
      action: adapted.action,
      welinkSessionId: adapted.welinkSessionId,
      toolSessionId: getInvokeToolSessionId(adapted),
    };
    const invokeResult = await this.handleInvoke(adapted as InvokeMessage, invokeContext);
    if (invokeResult.success) {
      this.options.logger.info("runtime.invoke.completed", {
        ...fields,
        action: adapted.action,
        welinkSessionId: adapted.welinkSessionId,
        toolSessionId: getInvokeToolSessionId(adapted),
        latencyMs: Date.now() - startedAt,
      });
      return;
    }
    this.options.logger.warn("runtime.invoke.failed", {
      ...fields,
      action: adapted.action,
      welinkSessionId: adapted.welinkSessionId,
      toolSessionId: getInvokeToolSessionId(adapted),
      latencyMs: Date.now() - startedAt,
      reason: invokeResult.reason,
    });
  }

  private applyCompatAdapter(message: GatewayBusinessMessage): DownstreamMessage {
    if (message.type !== DOWNSTREAM_MESSAGE_TYPE.INVOKE || message.action !== INVOKE_ACTION.CREATE_SESSION) {
      return message as DownstreamMessage;
    }

    const payload = normalizeLegacyCreateSessionPayload(message.rawPayload ?? message.payload).payload;
    return {
      ...message,
      payload,
    } as DownstreamMessage;
  }

  private async handleInvoke(
    message: InvokeMessage,
    context: UpstreamSendContext,
  ): Promise<{ success: boolean; reason?: string }> {
    switch (message.action) {
      case INVOKE_ACTION.CHAT:
        if (await this.handleChat(message, context)) {
          return { success: true };
        }
        return { success: false, reason: "chat_failed" };
      case INVOKE_ACTION.CREATE_SESSION:
        if (await this.handleCreateSession(message, context)) {
          return { success: true };
        }
        return { success: false, reason: "create_session_failed" };
      case INVOKE_ACTION.CLOSE_SESSION:
        if (await this.handleCloseSession(message, context)) {
          return { success: true };
        }
        return { success: false, reason: "close_session_failed" };
      case INVOKE_ACTION.ABORT_SESSION:
        if (await this.handleAbortSession(message, context)) {
          return { success: true };
        }
        return { success: false, reason: "abort_session_failed" };
      case INVOKE_ACTION.PERMISSION_REPLY:
      case INVOKE_ACTION.QUESTION_REPLY:
        this.sendUnsupported(message.action, message.payload.toolSessionId, message.welinkSessionId, context);
        return { success: false, reason: `unsupported_action:${message.action}` };
    }
  }

  private async handleChat(
    message: Extract<InvokeMessage, { action: "chat" }>,
    context: UpstreamSendContext,
  ): Promise<boolean> {
    const record = this.sessionRegistry.ensure(message.payload.toolSessionId, message.welinkSessionId);
    this.clearSessionTermination(record);
    const assistantStream = createAssistantStreamState(record.sessionKey);
    const toolStates = new Map<string, ToolPartState>();
    const startedAt = Date.now();
    const chatRequestId = randomUUID();
    const configuredTimeoutMs = this.options.account.runTimeoutMs;
    const selectedModel = createSelectedModelState();
    const {
      effectiveConfig,
      streamDefaultsInjected,
      malformedConfigPaths,
      streamingEnabled,
      streamingSource,
    } = resolveEffectiveReplyConfig(
      this.options.config,
    );
    const hasRouteResolver = !!this.runtime.channel?.routing?.resolveAgentRoute;
    const hasReplyRuntime = !!this.runtime.channel?.reply;
    const pathSelection = this.resolveChatExecutionPath({
      streamingEnabled,
      hasRouteResolver,
      hasReplyRuntime,
    });
    const executionPath = pathSelection.executionPath;
    const streamMode = pathSelection.streamMode;
    const effectiveStreamDefaultsInjected =
      streamMode === "runtime_block_streaming" ? streamDefaultsInjected : false;
    if (malformedConfigPaths.length > 0) {
      this.options.logger.warn("bridge.chat.config_shape_corrected", {
        toolSessionId: record.toolSessionId,
        welinkSessionId: record.welinkSessionId,
        sessionKey: record.sessionKey,
        executionPath,
        streamMode,
        chatRequestId,
        retryAttempt: 0,
        malformedConfigPaths,
        streamingEnabled,
        streamingSource,
      });
    }
    this.activeToolSessions.set(record.sessionKey, {
      toolSessionId: record.toolSessionId,
      runId: null,
      assistantStream,
      toolStates,
      pendingToolResultTarget: null,
    });
    this.sendToolEvent({
      type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
      toolSessionId: record.toolSessionId,
      event: buildBusyEvent(record.sessionKey),
    }, context);
    this.logChatPathSelected({
      toolSessionId: record.toolSessionId,
      welinkSessionId: record.welinkSessionId,
      sessionKey: record.sessionKey,
      configuredTimeoutMs,
      executionPath,
      streamMode,
      streamDefaultsInjected: effectiveStreamDefaultsInjected,
      streamingEnabled,
      streamingSource,
      reason: pathSelection.reason,
      chatRequestId,
      retryAttempt: 0,
    });
    this.logChatStarted({
      toolSessionId: record.toolSessionId,
      welinkSessionId: record.welinkSessionId,
      sessionKey: record.sessionKey,
      chatText: message.payload.text,
      textLength: message.payload.text.length,
      startedAt,
      configuredTimeoutMs,
      executionPath,
      streamMode,
      streamDefaultsInjected: effectiveStreamDefaultsInjected,
      streamingEnabled,
      streamingSource,
      chatRequestId,
      retryAttempt: 0,
    });
    let retryAttempt: RetryAttempt = 0;
    let lastErrorMessage: string | null = null;
    let lastErrorExtra: Record<string, unknown> | undefined;
    let pendingFinalText: string | null = null;

    while (true) {
      pendingFinalText = null;
      if (
        executionPath !== "runtime_reply" ||
        !this.runtime.channel?.routing?.resolveAgentRoute ||
        !this.runtime.channel?.reply
      ) {
        const fallbackResult = await this.handleChatWithSubagentFallback(
          record,
          message.payload.text,
          startedAt,
          selectedModel,
          chatRequestId,
          retryAttempt,
          effectiveStreamDefaultsInjected,
          streamingEnabled,
          streamingSource,
          context,
        );
        if (fallbackResult.ok) {
          return true;
        }
        lastErrorMessage = fallbackResult.errorMessage;
        lastErrorExtra = fallbackResult.extra;
        if (retryAttempt === 0 && this.shouldRetryBeforeFirstChunkTimeout(lastErrorMessage, assistantStream)) {
          retryAttempt = 1;
          this.logChatStarted({
            toolSessionId: record.toolSessionId,
            welinkSessionId: record.welinkSessionId,
            sessionKey: record.sessionKey,
            chatText: message.payload.text,
            textLength: message.payload.text.length,
            startedAt,
            configuredTimeoutMs,
            executionPath,
            streamMode,
            streamDefaultsInjected: effectiveStreamDefaultsInjected,
            streamingEnabled,
            streamingSource,
            chatRequestId,
            retryAttempt,
          });
          continue;
        }
        break;
      }

      const route = this.runtime.channel.routing.resolveAgentRoute({
        cfg: effectiveConfig,
        channel: "message-bridge",
        accountId: this.options.account.accountId,
        peer: {
          kind: "direct",
          id: record.welinkSessionId || record.toolSessionId,
        },
      });
      const envelopeOptions = this.runtime.channel.reply.resolveEnvelopeFormatOptions(effectiveConfig);
      const body = this.runtime.channel.reply.formatAgentEnvelope({
        channel: "message-bridge",
        from: `ai-gateway:${record.welinkSessionId || record.toolSessionId}`,
        timestamp: new Date(),
        previousTimestamp: undefined,
        envelope: envelopeOptions,
        body: message.payload.text,
      });
      const ctxPayload = this.runtime.channel.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: message.payload.text,
        RawBody: message.payload.text,
        CommandBody: message.payload.text,
        From: `message-bridge:${record.welinkSessionId || record.toolSessionId}`,
        To: `message-bridge:${record.toolSessionId}`,
        SessionKey: record.sessionKey,
        AccountId: route.accountId,
        ChatType: "direct",
        ConversationLabel: `ai-gateway:${record.welinkSessionId || record.toolSessionId}`,
        SenderName: "ai-gateway",
        SenderId: record.welinkSessionId || record.toolSessionId,
        Provider: "message-bridge",
        Surface: "message-bridge",
        Timestamp: new Date().toISOString(),
        OriginatingChannel: "message-bridge",
        OriginatingTo: `message-bridge:${record.toolSessionId}`,
        CommandAuthorized: false,
      });
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg: effectiveConfig,
        agentId: route.agentId,
        channel: "message-bridge",
        accountId: this.options.account.accountId,
      });
      const handleModelSelected = (selection: { provider: string; model: string; thinkLevel: string | undefined }) => {
        selectedModel.provider = selection.provider;
        selectedModel.model = selection.model;
        selectedModel.thinkLevel = selection.thinkLevel ?? null;
        this.options.logger.info("bridge.chat.model_selected", {
          toolSessionId: record.toolSessionId,
          sessionKey: record.sessionKey,
          configuredTimeoutMs,
          runTimeoutMs: configuredTimeoutMs,
          executionPath: "runtime_reply",
          streamMode,
          chatRequestId,
          retryAttempt,
          streamDefaultsInjected: effectiveStreamDefaultsInjected,
          streamingEnabled,
          streamingSource,
          provider: selection.provider,
          model: selection.model,
          thinkLevel: selection.thinkLevel ?? null,
        });
        onModelSelected?.(selection);
      };
      const deliver = async (rawPayload: unknown, info: { kind: "tool" | "block" | "final" }) => {
        if (this.isSessionTerminated(record)) {
          return;
        }
        const payload =
          asRecord(rawPayload) ? normalizeOutboundReplyPayload(rawPayload) : normalizeOutboundReplyPayload({});

        if (info.kind === "tool") {
          const activeSession = this.activeToolSessions.get(record.sessionKey);
          const toolCallId = activeSession?.pendingToolResultTarget;
          if (!toolCallId) {
            return;
          }

          const toolState = activeSession.toolStates.get(toolCallId);
          if (!toolState) {
            return;
          }

          const output = typeof payload.text === "string" ? payload.text.trim() : "";
          if (output.length === 0) {
            return;
          }

          toolState.output = output;
          this.emitToolPartUpdate(record.toolSessionId, toolState, context);
          return;
        }

        const payloadText = typeof payload.text === "string" ? payload.text : "";

        if (info.kind === "final") {
          if (payloadText.length > 0) {
            pendingFinalText = payloadText;
          }
          return;
        }

        if (info.kind !== "block" || payloadText.length === 0) {
          return;
        }

        if (!streamingEnabled) {
          assistantStream.accumulatedText += payloadText;
          return;
        }

        {
          const now = Date.now();
          assistantStream.chunkCount += 1;
          if (assistantStream.firstChunkAt === null) {
            assistantStream.firstChunkAt = now;
            this.options.logger.info("bridge.chat.first_chunk", {
              toolSessionId: record.toolSessionId,
              sessionKey: record.sessionKey,
              chatRequestId,
              retryAttempt,
              latencyMs: now - startedAt,
              chunkLength: payloadText.length,
              deltaText: payloadText,
            });
          } else {
            this.options.logger.info("bridge.chat.chunk", {
              toolSessionId: record.toolSessionId,
              sessionKey: record.sessionKey,
              chatRequestId,
              retryAttempt,
              chunkIndex: assistantStream.chunkCount,
              chunkLength: payloadText.length,
              sinceStartMs: now - startedAt,
              sinceFirstChunkMs: now - assistantStream.firstChunkAt,
              deltaText: payloadText,
            });
          }
          this.sendAssistantStreamChunk(record.toolSessionId, assistantStream, payloadText, context);
        }
      };

      try {
        await this.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: effectiveConfig,
          dispatcherOptions: {
            ...prefixOptions,
            deliver,
            onError: (error) => {
              throw error;
            },
          },
          replyOptions: {
            onAgentRunStart: (runId) => {
              this.trackSessionRunId(record.sessionKey, runId);
            },
            onModelSelected: handleModelSelected,
            timeoutOverrideSeconds: Math.ceil(configuredTimeoutMs / 1000),
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (retryAttempt === 0 && this.shouldRetryBeforeFirstChunkTimeout(errorMessage, assistantStream)) {
          retryAttempt = 1;
          this.logChatStarted({
            toolSessionId: record.toolSessionId,
            welinkSessionId: record.welinkSessionId,
            sessionKey: record.sessionKey,
            chatText: message.payload.text,
            textLength: message.payload.text.length,
            startedAt,
            configuredTimeoutMs,
            executionPath,
            streamMode,
            streamDefaultsInjected: effectiveStreamDefaultsInjected,
            streamingEnabled,
            streamingSource,
            chatRequestId,
            retryAttempt,
          });
          continue;
        }
        lastErrorMessage = errorMessage;
        lastErrorExtra = undefined;
        break;
      }
      if (this.isSessionTerminated(record)) {
        this.clearActiveToolSession(record.sessionKey);
        return true;
      }
      const reconciliation = reconcileFinalText(assistantStream.accumulatedText, pendingFinalText);
      assistantStream.accumulatedText = reconciliation.finalText;
      const finalText = assistantStream.accumulatedText || "(empty response)";
      this.sendAssistantFinalResponse(
        record.toolSessionId,
        assistantStream,
        finalText,
        context,
      );
      this.logChatCompleted({
        toolSessionId: record.toolSessionId,
        sessionKey: record.sessionKey,
        configuredTimeoutMs,
        startedAt,
        assistantStream,
        selectedModel,
        executionPath: "runtime_reply",
        streamMode,
        streamDefaultsInjected: effectiveStreamDefaultsInjected,
        streamingEnabled,
        streamingSource,
        chatRequestId,
        retryAttempt,
        finalReconciled: reconciliation.finalReconciled,
        responseLength: finalText.length,
        finalText,
      });
      this.sendToolEvent({
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId: record.toolSessionId,
        event: buildIdleEvent(record.sessionKey),
      }, context);
      this.sendToolDone({
        type: UPSTREAM_MESSAGE_TYPE.TOOL_DONE,
        toolSessionId: record.toolSessionId,
        welinkSessionId: context.welinkSessionId,
      }, context);
      this.clearActiveToolSession(record.sessionKey);
      return true;
    }

    if (this.isSessionTerminated(record)) {
      this.clearActiveToolSession(record.sessionKey);
      return true;
    }
    this.clearActiveToolSession(record.sessionKey);
    const finalErrorMessage = lastErrorMessage ?? "chat_failed_without_error";
    this.logChatFailed({
      toolSessionId: record.toolSessionId,
      sessionKey: record.sessionKey,
      configuredTimeoutMs,
      startedAt,
      assistantStream,
      selectedModel,
      executionPath,
      streamMode,
      streamDefaultsInjected: effectiveStreamDefaultsInjected,
      streamingEnabled,
      streamingSource,
      chatRequestId,
      retryAttempt,
      finalReconciled: false,
      error: finalErrorMessage,
      extra: lastErrorExtra,
    });
    this.sendToolEvent({
      type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
      toolSessionId: record.toolSessionId,
      event: buildSessionErrorEvent(record.sessionKey, finalErrorMessage),
    }, context);
    this.sendToolError({
      type: UPSTREAM_MESSAGE_TYPE.TOOL_ERROR,
      toolSessionId: record.toolSessionId,
      welinkSessionId: context.welinkSessionId,
      error: finalErrorMessage,
    }, context);
    return false;
  }

  private async handleChatWithSubagentFallback(
    record: { toolSessionId: string; welinkSessionId?: string; sessionKey: string },
    text: string,
    startedAt: number,
    selectedModel: SelectedModelState,
    chatRequestId: string,
    retryAttempt: RetryAttempt,
    streamDefaultsInjected: boolean,
    streamingEnabled: boolean,
    streamingSource: StreamingSource,
    context: UpstreamSendContext,
  ): Promise<{ ok: true } | { ok: false; errorMessage: string; extra?: Record<string, unknown> }> {
    const assistantStream = createAssistantStreamState(record.sessionKey);
    const configuredTimeoutMs = this.options.account.runTimeoutMs;
    const subagent = this.getSubagentRuntime();
    if (!subagent) {
      const errorMessage = "openclaw_runtime_missing_reply_executor";
      return { ok: false, errorMessage };
    }

    try {
      const run = await subagent.run({
        sessionKey: record.sessionKey,
        message: text,
        deliver: false,
        idempotencyKey: `chat:${record.toolSessionId}:${chatRequestId}`,
      });

      const wait = await subagent.waitForRun({
        runId: run.runId,
        timeoutMs: configuredTimeoutMs,
      });

      if (this.isSessionTerminated(record)) {
        return { ok: true };
      }

      if (wait.status !== "ok") {
        const errorMessage = wait.error || `subagent_${wait.status}`;
        return {
          ok: false,
          errorMessage,
          extra: {
            waitStatus: wait.status,
            waitError: wait.error ?? null,
          },
        };
      }

      const session = await subagent.getSessionMessages({
        sessionKey: record.sessionKey,
        limit: 50,
      });
      if (this.isSessionTerminated(record)) {
        return { ok: true };
      }
      const assistantText = extractAssistantText(session.messages) || "(empty response)";
      this.sendAssistantFinalResponse(record.toolSessionId, assistantStream, assistantText, context);
      this.logChatCompleted({
        toolSessionId: record.toolSessionId,
        sessionKey: record.sessionKey,
        configuredTimeoutMs,
        startedAt,
        assistantStream,
        selectedModel,
        executionPath: "subagent_fallback",
        streamMode: "fallback_non_streaming",
        streamDefaultsInjected,
        streamingEnabled,
        streamingSource,
        chatRequestId,
        retryAttempt,
        finalReconciled: false,
        responseLength: assistantText.length,
        finalText: assistantText,
        extra: {
          waitStatus: wait.status,
          waitError: wait.error ?? null,
        },
      });
      this.sendToolEvent({
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId: record.toolSessionId,
        event: buildIdleEvent(record.sessionKey),
      }, context);
      this.sendToolDone({
        type: UPSTREAM_MESSAGE_TYPE.TOOL_DONE,
        toolSessionId: record.toolSessionId,
        welinkSessionId: context.welinkSessionId,
      }, context);
      this.clearActiveToolSession(record.sessionKey);
      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { ok: false, errorMessage };
    }
  }

  private shouldRetryBeforeFirstChunkTimeout(errorMessage: string, assistantStream: AssistantStreamState): boolean {
    const lowered = errorMessage.toLowerCase();
    const isTimeout = lowered.includes("timed out") || lowered.includes("timeout");
    return assistantStream.firstChunkAt === null && isTimeout;
  }

  private async deleteHostSession(record: { sessionKey: string }): Promise<void> {
    const subagent = this.getSubagentRuntime();
    if (subagent?.deleteSession) {
      await subagent.deleteSession({
        sessionKey: record.sessionKey,
      });
      return;
    }

    throw new Error("openclaw_runtime_missing_session_deleter");
  }

  private async handleCreateSession(
    message: Extract<InvokeMessage, { action: "create_session" }>,
    context: UpstreamSendContext,
  ): Promise<boolean> {
    const requestedSessionId = message.payload.sessionId?.trim();
    const toolSessionId = requestedSessionId && requestedSessionId.length > 0 ? requestedSessionId : randomUUID();
    const record = this.sessionRegistry.ensure(toolSessionId, message.welinkSessionId);
    const response: SessionCreatedMessage = {
      type: UPSTREAM_MESSAGE_TYPE.SESSION_CREATED,
      welinkSessionId: message.welinkSessionId,
      toolSessionId: record.toolSessionId,
      session: {
        sessionId: record.toolSessionId,
      },
    };
    const sent = this.sendValidatedUpstreamMessage(response, {
      ...context,
      toolSessionId: record.toolSessionId,
      welinkSessionId: message.welinkSessionId,
    });
    return sent;
  }

  private async handleCloseSession(
    message: Extract<InvokeMessage, { action: "close_session" }>,
    context: UpstreamSendContext,
  ): Promise<boolean> {
    const record = this.sessionRegistry.get(message.payload.toolSessionId);
    if (!record) {
      this.sendToolError({
        type: UPSTREAM_MESSAGE_TYPE.TOOL_ERROR,
        toolSessionId: message.payload.toolSessionId,
        welinkSessionId: message.welinkSessionId,
        error: "unknown_tool_session",
        reason: TOOL_ERROR_REASON.SESSION_NOT_FOUND,
      }, context);
      return false;
    }

    this.markSessionTerminated(record);
    try {
      await this.deleteHostSession(record);
      this.clearActiveToolSession(record.sessionKey);
      this.sessionRegistry.delete(message.payload.toolSessionId);
      return true;
    } catch (error) {
      this.clearSessionTermination(record);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendToolError({
        type: UPSTREAM_MESSAGE_TYPE.TOOL_ERROR,
        toolSessionId: message.payload.toolSessionId,
        welinkSessionId: message.welinkSessionId,
        error: errorMessage,
      }, context);
      return false;
    }
  }

  private async handleAbortSession(
    message: Extract<InvokeMessage, { action: "abort_session" }>,
    context: UpstreamSendContext,
  ): Promise<boolean> {
    const record = this.sessionRegistry.get(message.payload.toolSessionId);
    if (!record) {
      this.sendToolError({
        type: UPSTREAM_MESSAGE_TYPE.TOOL_ERROR,
        toolSessionId: message.payload.toolSessionId,
        welinkSessionId: message.welinkSessionId,
        error: "unknown_tool_session",
        reason: TOOL_ERROR_REASON.SESSION_NOT_FOUND,
      }, context);
      return false;
    }

    this.markSessionTerminated(record);
    try {
      this.clearActiveToolSession(record.sessionKey);
      this.sendToolDone({
        type: UPSTREAM_MESSAGE_TYPE.TOOL_DONE,
        toolSessionId: message.payload.toolSessionId,
        welinkSessionId: message.welinkSessionId,
      }, context);
      return true;
    } catch (error) {
      this.clearSessionTermination(record);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendToolError({
        type: UPSTREAM_MESSAGE_TYPE.TOOL_ERROR,
        toolSessionId: message.payload.toolSessionId,
        welinkSessionId: message.welinkSessionId,
        error: errorMessage,
      }, context);
      return false;
    }
  }

  private sendUnsupported(
    action: string,
    toolSessionId: string | undefined,
    welinkSessionId: string | undefined,
    context: UpstreamSendContext,
  ): void {
    this.sendToolError({
      type: UPSTREAM_MESSAGE_TYPE.TOOL_ERROR,
      toolSessionId,
      welinkSessionId,
      error: `unsupported_in_openclaw_v1:${action}`,
    }, context);
  }

  private buildSendContext(message: { toolSessionId?: string; welinkSessionId?: string }, context?: UpstreamSendContext): UpstreamSendContext {
    return {
      gatewayMessageId: context?.gatewayMessageId,
      action: context?.action,
      welinkSessionId: context?.welinkSessionId ?? message.welinkSessionId,
      toolSessionId: context?.toolSessionId ?? message.toolSessionId,
    };
  }

  private buildChatEventContext(toolSessionId: string): UpstreamSendContext {
    return {
      action: INVOKE_ACTION.CHAT,
      toolSessionId,
    };
  }

  private sendToolEvent(message: ToolEventMessage, context?: UpstreamSendContext): void {
    const sendContext = this.buildSendContext(message, context);
    const event = asRecord(message.event);
    const eventType = asTrimmedString(event?.type);
    logDebug(this.options.logger, "runtime.tool_event.sending", {
      gatewayMessageId: sendContext.gatewayMessageId,
      action: sendContext.action,
      welinkSessionId: sendContext.welinkSessionId,
      toolSessionId: sendContext.toolSessionId,
      eventType,
    });
    try {
      this.sendValidatedUpstreamMessage(message, {
        ...sendContext,
        eventType,
      });
    } catch {
      this.options.logger.warn("runtime.tool_event.skipped_no_connection", {
        gatewayMessageId: sendContext.gatewayMessageId,
        action: sendContext.action,
        welinkSessionId: sendContext.welinkSessionId,
        toolSessionId: sendContext.toolSessionId,
        eventType,
      });
    }
  }

  private sendValidatedUpstreamMessage(
    message: UpstreamMessage,
    context?: UpstreamSendContext & { eventType?: string },
  ): boolean {
    // openclaw 侧的统一发送出口。所有候选上行消息必须先通过共享协议校验，失败直接 fail-closed。
    const validation = validateUpstreamMessage(message);
    if (!validation.ok) {
      const violation = validation.error.violation;
      this.options.logger.error("runtime.upstream_validation_failed", {
        gatewayMessageId: context?.gatewayMessageId,
        action: context?.action,
        welinkSessionId: context?.welinkSessionId,
        toolSessionId: context?.toolSessionId,
        eventType: violation.eventType ?? context?.eventType,
        messageType: message.type,
        stage: violation.stage,
        errorCode: violation.code,
        field: violation.field,
        errorMessage: violation.message,
      });
      return false;
    }

    this.connection.send(validation.value, {
      ...context,
      eventType: context?.eventType,
    });
    return true;
  }

  private sendToolDone(message: ToolDoneMessage, context?: UpstreamSendContext): void {
    const sendContext = this.buildSendContext(message, context);
    this.options.logger.info("runtime.tool_done.sending", {
      gatewayMessageId: sendContext.gatewayMessageId,
      action: sendContext.action,
      welinkSessionId: sendContext.welinkSessionId,
      toolSessionId: sendContext.toolSessionId,
    });
    try {
      this.sendValidatedUpstreamMessage(message, sendContext);
    } catch {
      this.options.logger.warn("runtime.tool_done.skipped_no_connection", {
        gatewayMessageId: sendContext.gatewayMessageId,
        action: sendContext.action,
        welinkSessionId: sendContext.welinkSessionId,
        toolSessionId: sendContext.toolSessionId,
      });
    }
  }

  private sendToolError(message: ToolErrorMessage, context?: UpstreamSendContext): void {
    const sendContext = this.buildSendContext(message, context);
    this.options.logger.error("runtime.tool_error.sending", {
      gatewayMessageId: sendContext.gatewayMessageId,
      action: sendContext.action,
      welinkSessionId: sendContext.welinkSessionId,
      toolSessionId: sendContext.toolSessionId,
      error: message.error,
      reason: message.reason,
    });
    try {
      this.sendValidatedUpstreamMessage(message, sendContext);
    } catch {
      this.options.logger.warn("runtime.tool_error.skipped_no_connection", {
        gatewayMessageId: sendContext.gatewayMessageId,
        action: sendContext.action,
        welinkSessionId: sendContext.welinkSessionId,
        toolSessionId: sendContext.toolSessionId,
      });
    }
  }

  private sendAssistantStreamChunk(
    toolSessionId: string,
    state: AssistantStreamState,
    chunk: string,
    context: UpstreamSendContext,
  ): void {
    state.accumulatedText += chunk;

    if (state.accumulatedText === chunk) {
      this.ensureAssistantMessageStarted(toolSessionId, state, context);
      this.sendToolEvent({
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: buildAssistantPartUpdated(state.sessionKey, state.messageId, state.partId, chunk, chunk),
      }, context);
      return;
    }

    this.sendToolEvent({
      type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
      toolSessionId,
      event: buildAssistantPartDelta(state.sessionKey, state.messageId, state.partId, chunk),
    }, context);
  }

  private ensureAssistantMessageStarted(
    toolSessionId: string,
    state: AssistantStreamState,
    context: UpstreamSendContext,
  ): void {
    if (state.seeded) {
      return;
    }

    this.sendToolEvent({
      type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
      toolSessionId,
      event: buildAssistantMessageUpdated(state.sessionKey, state.messageId),
    }, context);
    state.seeded = true;
  }

  private sendAssistantFinalResponse(
    toolSessionId: string,
    state: AssistantStreamState,
    text: string,
    context: UpstreamSendContext,
  ): void {
    if (state.seeded) {
      if (state.accumulatedText.length === 0) {
        this.sendToolEvent({
          type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
          toolSessionId,
          event: buildAssistantPartUpdated(state.sessionKey, state.messageId, state.partId, text),
        }, context);
        return;
      }
      this.sendToolEvent({
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: buildAssistantPartUpdated(
          state.sessionKey,
          state.messageId,
          state.partId,
          state.accumulatedText || text,
        ),
      }, context);
      return;
    }

    this.sendToolEvent({
      type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
      toolSessionId,
      event: buildAssistantMessageUpdated(state.sessionKey, state.messageId),
    }, context);
    this.sendToolEvent({
      type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
      toolSessionId,
      event: buildAssistantPartUpdated(state.sessionKey, state.messageId, state.partId, text),
    }, context);
    state.seeded = true;
  }

  private emitToolPartUpdate(toolSessionId: string, toolState: ToolPartState, context: UpstreamSendContext): void {
    if (this.terminatedToolSessionIds.has(toolSessionId) || this.terminatedSessionKeys.has(toolState.sessionKey)) {
      return;
    }
    this.sendToolEvent({
      type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
      toolSessionId,
      event: buildToolPartUpdated(toolState),
    }, context);
  }

  private trackSessionRunId(sessionKey: string, runId: string): void {
    if (!runId) {
      return;
    }

    const activeSession = this.activeToolSessions.get(sessionKey);
    if (!activeSession) {
      return;
    }

    if (activeSession.runId && activeSession.runId !== runId) {
      this.activeRunToSessionKey.delete(activeSession.runId);
    }

    activeSession.runId = runId;
    this.activeRunToSessionKey.set(runId, sessionKey);
  }

  private clearActiveToolSession(sessionKey: string): void {
    const activeSession = this.activeToolSessions.get(sessionKey);
    if (activeSession?.runId) {
      this.activeRunToSessionKey.delete(activeSession.runId);
    }
    this.activeToolSessions.delete(sessionKey);
  }

  private isSessionTerminated(record: { toolSessionId: string; sessionKey: string }): boolean {
    return (
      this.terminatedToolSessionIds.has(record.toolSessionId) ||
      this.terminatedSessionKeys.has(record.sessionKey)
    );
  }

  private markSessionTerminated(record: { toolSessionId: string; sessionKey: string }): void {
    this.terminatedToolSessionIds.add(record.toolSessionId);
    this.terminatedSessionKeys.add(record.sessionKey);
  }

  private clearSessionTermination(record: { toolSessionId: string; sessionKey: string }): void {
    this.terminatedToolSessionIds.delete(record.toolSessionId);
    this.terminatedSessionKeys.delete(record.sessionKey);
  }

  private handleRuntimeAgentEvent(evt: ToolAgentEvent): void {
    if (evt.stream !== MESSAGE_PART_TYPE.TOOL || !asRecord(evt.data)) {
      return;
    }

    const directSessionKey = typeof evt.sessionKey === "string" ? evt.sessionKey : undefined;
    const mappedSessionKey =
      typeof evt.runId === "string" && evt.runId.length > 0 ? this.activeRunToSessionKey.get(evt.runId) : undefined;
    const sessionKey = directSessionKey ?? mappedSessionKey;
    const activeSession =
      (directSessionKey ? this.activeToolSessions.get(directSessionKey) : undefined) ??
      (mappedSessionKey ? this.activeToolSessions.get(mappedSessionKey) : undefined);
    if (!sessionKey || !activeSession) {
      return;
    }
    if (
      this.terminatedSessionKeys.has(sessionKey) ||
      this.terminatedToolSessionIds.has(activeSession.toolSessionId)
    ) {
      return;
    }

    const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
    const toolName = typeof evt.data.name === "string" && evt.data.name.length > 0 ? evt.data.name : MESSAGE_PART_TYPE.TOOL;
    const toolCallId =
      typeof evt.data.toolCallId === "string" && evt.data.toolCallId.length > 0
        ? evt.data.toolCallId
        : `tool_${randomUUID()}`;

    const context = this.buildChatEventContext(activeSession.toolSessionId);
    this.ensureAssistantMessageStarted(activeSession.toolSessionId, activeSession.assistantStream, context);

    let toolState = activeSession.toolStates.get(toolCallId);
    if (!toolState) {
      const nextToolState: ToolPartState = {
        toolCallId,
        toolName,
        partId: `tool_${randomUUID()}`,
        messageId: activeSession.assistantStream.messageId,
        sessionKey,
        status: TOOL_PART_STATUS.RUNNING,
      };
      activeSession.toolStates.set(toolCallId, nextToolState);
      toolState = nextToolState;
    }

    toolState.toolName = toolName;
    toolState.title = extractToolResultTitle(evt.data.meta, toolName) ?? toolState.title;

    if (phase === "start" || phase === "update") {
      toolState.status = TOOL_PART_STATUS.RUNNING;
      this.emitToolPartUpdate(activeSession.toolSessionId, toolState, context);
      return;
    }

    if (phase === "result") {
      const isError = evt.data.isError === true;
      toolState.status = isError ? TOOL_PART_STATUS.ERROR : TOOL_PART_STATUS.COMPLETED;
      toolState.error = isError ? `tool_${toolName}_failed` : undefined;
      activeSession.pendingToolResultTarget = toolCallId;
      this.emitToolPartUpdate(activeSession.toolSessionId, toolState, context);
    }
  }

  private logChatStarted(params: {
    toolSessionId: string;
    welinkSessionId?: string;
    sessionKey: string;
    chatText: string;
    textLength: number;
    startedAt: number;
    configuredTimeoutMs: number;
    executionPath: ChatExecutionPath;
    streamMode: StreamMode;
    streamDefaultsInjected: boolean;
    streamingEnabled: boolean;
    streamingSource: StreamingSource;
    chatRequestId: string;
    retryAttempt: RetryAttempt;
  }): void {
    this.options.logger.info("bridge.chat.started", {
      toolSessionId: params.toolSessionId,
      welinkSessionId: params.welinkSessionId,
      sessionKey: params.sessionKey,
      chatText: params.chatText,
      textLength: params.textLength,
      startedAt: params.startedAt,
      configuredTimeoutMs: params.configuredTimeoutMs,
      runTimeoutMs: params.configuredTimeoutMs,
      executionPath: params.executionPath,
      streamMode: params.streamMode,
      streamDefaultsInjected: params.streamDefaultsInjected,
      streamingEnabled: params.streamingEnabled,
      streamingSource: params.streamingSource,
      chatRequestId: params.chatRequestId,
      retryAttempt: params.retryAttempt,
    });
  }

  private resolveChatExecutionPath(params: {
    streamingEnabled: boolean;
    hasRouteResolver: boolean;
    hasReplyRuntime: boolean;
  }): {
    executionPath: ChatExecutionPath;
    streamMode: StreamMode;
    reason: ChatExecutionPathReason;
  } {
    return resolveStreamingExecutionPlan(params);
  }

  private logChatPathSelected(params: {
    toolSessionId: string;
    welinkSessionId?: string;
    sessionKey: string;
    configuredTimeoutMs: number;
    executionPath: ChatExecutionPath;
    streamMode: StreamMode;
    streamDefaultsInjected: boolean;
    streamingEnabled: boolean;
    streamingSource: StreamingSource;
    reason: ChatExecutionPathReason;
    chatRequestId: string;
    retryAttempt: RetryAttempt;
  }): void {
    this.options.logger.info("bridge.chat.path_selected", {
      toolSessionId: params.toolSessionId,
      welinkSessionId: params.welinkSessionId,
      sessionKey: params.sessionKey,
      configuredTimeoutMs: params.configuredTimeoutMs,
      runTimeoutMs: params.configuredTimeoutMs,
      executionPath: params.executionPath,
      streamMode: params.streamMode,
      streamDefaultsInjected: params.streamDefaultsInjected,
      streamingEnabled: params.streamingEnabled,
      streamingSource: params.streamingSource,
      reason: params.reason,
      chatRequestId: params.chatRequestId,
      retryAttempt: params.retryAttempt,
    });
  }

  private logChatCompleted(params: {
    toolSessionId: string;
    sessionKey: string;
    configuredTimeoutMs: number;
    startedAt: number;
    assistantStream: AssistantStreamState;
    selectedModel: SelectedModelState;
    executionPath: ChatExecutionPath;
    streamMode: StreamMode;
    streamDefaultsInjected: boolean;
    streamingEnabled: boolean;
    streamingSource: StreamingSource;
    chatRequestId: string;
    retryAttempt: RetryAttempt;
    finalReconciled: boolean;
    responseLength: number;
    finalText: string;
    extra?: Record<string, unknown>;
  }): void {
    this.options.logger.info("bridge.chat.completed", {
      ...this.buildChatDiagnostics(params),
      responseLength: params.responseLength,
      finalText: params.finalText,
      ...(params.extra ?? {}),
    });
  }

  private logChatFailed(params: {
    toolSessionId: string;
    sessionKey: string;
    configuredTimeoutMs: number;
    startedAt: number;
    assistantStream: AssistantStreamState;
    selectedModel: SelectedModelState;
    executionPath: ChatExecutionPath;
    streamMode: StreamMode;
    streamDefaultsInjected: boolean;
    streamingEnabled: boolean;
    streamingSource: StreamingSource;
    chatRequestId: string;
    retryAttempt: RetryAttempt;
    finalReconciled: boolean;
    error: string;
    extra?: Record<string, unknown>;
  }): void {
    const errorLower = params.error.toLowerCase();
    const isTimeout = errorLower.includes("timed out") || errorLower.includes("timeout");
    this.options.logger.warn("bridge.chat.failed", {
      ...this.buildChatDiagnostics(params),
      error: params.error,
      failureStage: params.assistantStream.firstChunkAt === null ? "before_first_chunk" : "after_first_chunk",
      errorCategory: isTimeout ? "timeout" : "runtime_error",
      timedOut: isTimeout,
      ...(params.extra ?? {}),
    });
  }

  private buildChatDiagnostics(params: {
    toolSessionId: string;
    sessionKey: string;
    configuredTimeoutMs: number;
    startedAt: number;
    assistantStream: AssistantStreamState;
    selectedModel: SelectedModelState;
    executionPath: ChatExecutionPath;
    streamMode: StreamMode;
    streamDefaultsInjected: boolean;
    streamingEnabled: boolean;
    streamingSource: StreamingSource;
    chatRequestId: string;
    retryAttempt: RetryAttempt;
    finalReconciled: boolean;
  }): Record<string, unknown> {
    return {
      toolSessionId: params.toolSessionId,
      sessionKey: params.sessionKey,
      configuredTimeoutMs: params.configuredTimeoutMs,
      runTimeoutMs: params.configuredTimeoutMs,
      executionPath: params.executionPath,
      streamMode: params.streamMode,
      streamDefaultsInjected: params.streamDefaultsInjected,
      streamingEnabled: params.streamingEnabled,
      streamingSource: params.streamingSource,
      chatRequestId: params.chatRequestId,
      retryAttempt: params.retryAttempt,
      finalReconciled: params.finalReconciled,
      provider: params.selectedModel.provider,
      model: params.selectedModel.model,
      thinkLevel: params.selectedModel.thinkLevel,
      chunkCount: params.assistantStream.chunkCount,
      firstChunkLatencyMs:
        params.assistantStream.firstChunkAt === null ? null : params.assistantStream.firstChunkAt - params.startedAt,
      totalLatencyMs: Date.now() - params.startedAt,
    };
  }
}
