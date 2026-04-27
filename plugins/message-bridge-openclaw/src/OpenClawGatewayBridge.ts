import { randomUUID } from "node:crypto";
import os from "node:os";
import * as channelRuntime from "openclaw/plugin-sdk/channel-runtime";
import { normalizeOutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  type OpenClawConfig,
  type PluginRuntime,
} from "openclaw/plugin-sdk";
import type {
  DownstreamMessage,
  InvokeMessage,
} from "./contracts/downstream.js";
import type {
  SessionCreatedMessage,
  StatusResponseMessage,
  ToolDoneMessage,
  ToolErrorMessage,
  ToolEventMessage,
} from "./contracts/transport.js";
import { TOOL_ERROR_REASON } from "./contracts/transport.js";
import type { BridgeLogger, MessageBridgeResolvedAccount, MessageBridgeStatusSnapshot } from "./types.js";
import type { GatewayConnection } from "./connection/GatewayConnection.js";
import { DefaultAkSkAuth } from "./connection/AkSkAuth.js";
import { DefaultGatewayConnection } from "./connection/GatewayConnection.js";
import { normalizeDownstreamMessage } from "./protocol/downstream.js";
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
import {
  buildBusyEvent,
  buildIdleEvent,
  buildMessagePartDelta,
  buildMessageUpdated,
  buildSessionUpdated,
  buildSessionErrorEvent,
  buildStepFinishPartUpdated,
  buildStepStartPartUpdated,
  buildTextPartUpdated,
  buildToolPartUpdated,
  buildReasoningPartUpdated,
  createToolSessionId,
} from "./session/upstreamEvents.js";

export interface OpenClawGatewayBridgeOptions {
  account: MessageBridgeResolvedAccount;
  config: OpenClawConfig;
  logger: BridgeLogger;
  runtime: PluginRuntime;
  setStatus: (status: MessageBridgeStatusSnapshot) => void;
  registerMetadata?: RegisterMetadata;
  connectionFactory?: (account: MessageBridgeResolvedAccount, logger: BridgeLogger) => GatewayConnection;
}

type SessionDeletionRuntime = PluginRuntime & {
  subagent: {
    deleteSession(params: { sessionKey: string }): Promise<void>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

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
  if (!isRecord(raw)) {
    return {};
  }
  const payload = isRecord(raw.payload) ? raw.payload : undefined;
  return {
    messageType: asString(raw.type),
    action: asString(raw.action),
    welinkSessionId: asString(raw.welinkSessionId),
    toolSessionId: asString(payload?.toolSessionId),
    gatewayMessageId: asString(raw.messageId),
  };
}

function getInvokeToolSessionId(message: InvokeMessage): string | undefined {
  if ("toolSessionId" in message.payload) {
    return message.payload.toolSessionId;
  }
  return undefined;
}

interface AssistantStreamState {
  messageId: string;
  textPartId: string;
  stepStartPartId: string;
  stepFinishPartId: string;
  reasoningPartId: string;
  sessionKey: string;
  seeded: boolean;
  stepStarted: boolean;
  stepFinished: boolean;
  textSeedUpdated: boolean;
  reasoningSeeded: boolean;
  messageCreatedAt: number;
  accumulatedText: string;
  latestPartialText: string | null;
  accumulatedReasoning: string;
  reasoningStartedAt: number | null;
  partialCount: number;
  firstPartialAt: number | null;
}

function createAssistantStreamState(sessionKey: string): AssistantStreamState {
  const createdAt = Date.now();
  return {
    messageId: `msg_${randomUUID()}`,
    textPartId: `prt_${randomUUID()}`,
    stepStartPartId: `prt_${randomUUID()}`,
    stepFinishPartId: `prt_${randomUUID()}`,
    reasoningPartId: `prt_${randomUUID()}`,
    sessionKey,
    seeded: false,
    stepStarted: false,
    stepFinished: false,
    textSeedUpdated: false,
    reasoningSeeded: false,
    messageCreatedAt: createdAt,
    accumulatedText: "",
    latestPartialText: null,
    accumulatedReasoning: "",
    reasoningStartedAt: null,
    partialCount: 0,
    firstPartialAt: null,
  };
}

interface ToolPartState {
  toolCallId: string;
  toolName: string;
  partId: string;
  messageId: string;
  sessionKey: string;
  status: "running" | "completed" | "error";
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

type ReplyDeliverKind = "tool" | "block" | "final";
type ReplyExecutorType = "runtime" | "buffered";

interface ReplyRuntimeCapabilities {
  resolveEnvelopeFormatOptions: (cfg: OpenClawConfig) => unknown;
  formatAgentEnvelope: (params: Record<string, unknown>) => string;
  finalizeInboundContext: (context: Record<string, unknown>) => Record<string, unknown>;
  createReplyDispatcherWithTyping?: (params: Record<string, unknown>) => {
    dispatcher: {
      waitForIdle?: () => Promise<void>;
    };
    replyOptions?: Record<string, unknown>;
    markDispatchIdle?: () => void;
    markFullyComplete?: () => void;
  };
  dispatchReplyFromConfig?: (params: Record<string, unknown>) => Promise<unknown>;
  dispatchReplyWithBufferedBlockDispatcher?: (params: Record<string, unknown>) => Promise<void>;
  resolveHumanDelayConfig?: (cfg: OpenClawConfig, agentId: string) => unknown;
}

interface ReplyExecutorSelection {
  executorType: ReplyExecutorType;
  fallbackReason: string | null;
}

interface ReplyProjectionCallbacks {
  onPartialReply: (text: unknown) => void;
  onReasoningStream: (text: unknown) => void;
  onDeliver: (rawPayload: unknown, info: { kind: ReplyDeliverKind }) => Promise<void>;
  onAgentRunStart: (runId: string) => void;
  onModelSelected: (selection: { provider: string; model: string; thinkLevel: string | undefined }) => void;
}

interface ReplyExecutionResult {
  executionPath: ChatExecutionPath;
  executorType: ReplyExecutorType;
  fallbackReason: string | null;
  dispatcherReturned: boolean;
  deliverCount: number;
  deliverKinds: Record<ReplyDeliverKind, number>;
  firstDeliverKind: ReplyDeliverKind | null;
  firstDeliverTextPreview: string | null;
  lastDeliverKind: ReplyDeliverKind | null;
  lastDeliverTextPreview: string | null;
  pendingFinalText: string | null;
  latestPartialText: string | null;
  firstVisibleReplyAt: number | null;
  hasVisibleBlockText: boolean;
  blockTextCandidate: string | null;
}

interface ReplyOutcome {
  kind: "assistant_success" | "structured_error" | "empty_response";
  finalText: string | null;
  responseSource: "partial_streaming" | "final_only" | "final_missing" | "block_fallback";
  errorMessage: string | null;
  shouldEmitAssistant: boolean;
  shouldEmitStructuredError: boolean;
}

interface ReplyExecutorParams {
  runtimeReply: ReplyRuntimeCapabilities;
  effectiveConfig: OpenClawConfig;
  ctxPayload: Record<string, unknown>;
  dispatcherFactoryParams: Record<string, unknown>;
  bufferedDispatcherOptions: Record<string, unknown>;
  configuredTimeoutMs: number;
  agentId: string;
  callbacks: ReplyProjectionCallbacks;
}

interface ReplyExecutor {
  readonly type: ReplyExecutorType;
  execute(params: ReplyExecutorParams): Promise<void>;
}

interface ReplyPrefixContextShape {
  responsePrefix: string;
  responsePrefixContextProvider: () => unknown;
}

function createSelectedModelState(): SelectedModelState {
  return {
    provider: null,
    model: null,
    thinkLevel: null,
  };
}

function extractToolResultTitle(meta: unknown, toolName: string): string | undefined {
  if (!isRecord(meta)) {
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

function extractToolResultText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["text", "message", "content", "output", "result", "error"]) {
    const nested = extractToolResultText(value[key]);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function summarizePayloadText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, 120);
}

function getReplyPrefixContext(cfg: OpenClawConfig, agentId: string): ReplyPrefixContextShape {
  const createPrefixContext = Reflect.get(channelRuntime, "createReplyPrefixContext");
  if (typeof createPrefixContext === "function") {
    const result = createPrefixContext({ cfg, agentId });
    if (isRecord(result)) {
      const responsePrefix = typeof result.responsePrefix === "string" ? result.responsePrefix : "";
      const responsePrefixContextProvider =
        typeof result.responsePrefixContextProvider === "function"
          ? result.responsePrefixContextProvider
          : () => ({});
      return {
        responsePrefix,
        responsePrefixContextProvider,
      };
    }
  }

  return {
    responsePrefix: "",
    responsePrefixContextProvider: () => ({}),
  };
}

class RuntimeReplyExecutor implements ReplyExecutor {
  readonly type = "runtime" as const;

  async execute(params: ReplyExecutorParams): Promise<void> {
    const factory = params.runtimeReply.createReplyDispatcherWithTyping;
    const dispatch = params.runtimeReply.dispatchReplyFromConfig;
    if (typeof factory !== "function" || typeof dispatch !== "function") {
      throw new Error("runtime_reply_executor_unavailable");
    }

    const dispatcherResult = factory({
      ...params.dispatcherFactoryParams,
      ...(typeof params.runtimeReply.resolveHumanDelayConfig === "function"
        ? { humanDelay: params.runtimeReply.resolveHumanDelayConfig(params.effectiveConfig, params.agentId) }
        : {}),
      onReplyStart: async () => undefined,
      onIdle: async () => undefined,
      onCleanup: async () => undefined,
      deliver: params.callbacks.onDeliver,
    });

    const dispatcher = dispatcherResult?.dispatcher;
    const replyOptions = isRecord(dispatcherResult?.replyOptions) ? dispatcherResult.replyOptions : {};
    const markDispatchIdle =
      typeof dispatcherResult?.markDispatchIdle === "function" ? dispatcherResult.markDispatchIdle : () => undefined;
    const markFullyComplete =
      typeof dispatcherResult?.markFullyComplete === "function" ? dispatcherResult.markFullyComplete : () => undefined;

    await dispatch({
      ctx: params.ctxPayload,
      cfg: params.effectiveConfig,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        onAgentRunStart: params.callbacks.onAgentRunStart,
        onModelSelected: params.callbacks.onModelSelected,
        onPartialReply: params.callbacks.onPartialReply,
        onReasoningStream: params.callbacks.onReasoningStream,
        timeoutOverrideSeconds: Math.ceil(params.configuredTimeoutMs / 1000),
      },
    });
    await dispatcher?.waitForIdle?.();
    markFullyComplete();
    markDispatchIdle();
  }
}

class BufferedReplyExecutor implements ReplyExecutor {
  readonly type = "buffered" as const;

  async execute(params: ReplyExecutorParams): Promise<void> {
    const dispatch = params.runtimeReply.dispatchReplyWithBufferedBlockDispatcher;
    if (typeof dispatch !== "function") {
      throw new Error("buffered_reply_executor_unavailable");
    }

    await dispatch({
      ctx: params.ctxPayload,
      cfg: params.effectiveConfig,
      dispatcherOptions: {
        ...params.bufferedDispatcherOptions,
        deliver: params.callbacks.onDeliver,
        onError: (error: unknown) => {
          throw error;
        },
      },
      replyOptions: {
        onAgentRunStart: params.callbacks.onAgentRunStart,
        onModelSelected: params.callbacks.onModelSelected,
        onPartialReply: params.callbacks.onPartialReply,
        onReasoningStream: params.callbacks.onReasoningStream,
        timeoutOverrideSeconds: Math.ceil(params.configuredTimeoutMs / 1000),
      },
    });
  }
}

class GatewayReplyProjector {
  private pendingFinalText: string | null = null;
  private dispatcherReturned = false;
  private deliverCount = 0;
  private readonly deliverKinds: Record<ReplyDeliverKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  private firstDeliverKind: ReplyDeliverKind | null = null;
  private firstDeliverTextPreview: string | null = null;
  private lastDeliverKind: ReplyDeliverKind | null = null;
  private lastDeliverTextPreview: string | null = null;
  private firstVisibleReplyAt: number | null = null;
  private hasVisibleBlockText = false;
  private blockTextCandidate: string | null = null;

  constructor(
    private readonly options: {
      streamingEnabled: boolean;
      onPartialReply: (text: string) => void;
      onReasoningStream: (text: string) => void;
      onToolDeliver: (payloadText: string) => void;
      onBlockObserved: (payloadText: string) => void;
    },
  ) {}

  onPartialReply = (text: unknown): void => {
    if (typeof text !== "string") {
      return;
    }
    if (!this.options.streamingEnabled) {
      return;
    }
    if (text.length > 0 && this.firstVisibleReplyAt === null) {
      this.firstVisibleReplyAt = Date.now();
    }
    this.options.onPartialReply(text);
  };

  onReasoningStream = (text: unknown): void => {
    if (!this.options.streamingEnabled || typeof text !== "string") {
      return;
    }
    this.options.onReasoningStream(text);
  };

  onDeliver = async (rawPayload: unknown, info: { kind: ReplyDeliverKind }): Promise<void> => {
    const payload =
      isRecord(rawPayload) ? normalizeOutboundReplyPayload(rawPayload) : normalizeOutboundReplyPayload({});
    const payloadText = typeof payload.text === "string" ? payload.text : "";
    this.recordDeliver(info.kind, payloadText);

    if (info.kind === "tool") {
      this.options.onToolDeliver(payloadText);
      return;
    }

    if (info.kind === "final") {
      this.pendingFinalText = payloadText;
      if (payloadText.length > 0 && this.firstVisibleReplyAt === null) {
        this.firstVisibleReplyAt = Date.now();
      }
      return;
    }

    const trimmed = payloadText.trim();
    if (trimmed.length > 0) {
      this.hasVisibleBlockText = true;
      this.blockTextCandidate = trimmed;
      if (this.firstVisibleReplyAt === null) {
        this.firstVisibleReplyAt = Date.now();
      }
    }
    this.options.onBlockObserved(payloadText);
  };

  markDispatcherReturned(): void {
    this.dispatcherReturned = true;
  }

  buildResult(params: {
    executionPath: ChatExecutionPath;
    executorType: ReplyExecutorType;
    fallbackReason: string | null;
    latestPartialText: string | null;
  }): ReplyExecutionResult {
    return {
      executionPath: params.executionPath,
      executorType: params.executorType,
      fallbackReason: params.fallbackReason,
      dispatcherReturned: this.dispatcherReturned,
      deliverCount: this.deliverCount,
      deliverKinds: { ...this.deliverKinds },
      firstDeliverKind: this.firstDeliverKind,
      firstDeliverTextPreview: this.firstDeliverTextPreview,
      lastDeliverKind: this.lastDeliverKind,
      lastDeliverTextPreview: this.lastDeliverTextPreview,
      pendingFinalText: this.pendingFinalText,
      latestPartialText: params.latestPartialText,
      firstVisibleReplyAt: this.firstVisibleReplyAt,
      hasVisibleBlockText: this.hasVisibleBlockText,
      blockTextCandidate: this.blockTextCandidate,
    };
  }

  snapshot(params: {
    executionPath: ChatExecutionPath;
    executorType: ReplyExecutorType;
    fallbackReason: string | null;
    latestPartialText: string | null;
  }): ReplyExecutionResult {
    return this.buildResult(params);
  }

  private recordDeliver(kind: ReplyDeliverKind, payloadText: string): void {
    this.deliverCount += 1;
    this.deliverKinds[kind] += 1;
    const preview = summarizePayloadText(payloadText);
    if (this.firstDeliverKind === null) {
      this.firstDeliverKind = kind;
      this.firstDeliverTextPreview = preview;
    }
    this.lastDeliverKind = kind;
    this.lastDeliverTextPreview = preview;
  }
}

export class OpenClawGatewayBridge {
  private readonly sessionRegistry: SessionRegistry;
  private readonly connection: GatewayConnection;
  private readonly runtime: PluginRuntime;
  private readonly registerMetadata: RegisterMetadata;
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
      new DefaultGatewayConnection({
        url: options.account.gateway.url,
        reconnectBaseMs: options.account.gateway.reconnect.baseMs,
        reconnectMaxMs: options.account.gateway.reconnect.maxMs,
        reconnectExponential: options.account.gateway.reconnect.exponential,
        heartbeatIntervalMs: options.account.gateway.heartbeatIntervalMs,
        debug: options.account.debug,
        authPayloadProvider: () =>
          new DefaultAkSkAuth(options.account.auth.ak, options.account.auth.sk).generateAuthPayload(),
        registerMessage: {
          type: "register",
          deviceName: this.registerMetadata.deviceName,
          macAddress: this.registerMetadata.macAddress,
          os: os.platform(),
          toolType: this.registerMetadata.toolType,
          toolVersion: this.registerMetadata.toolVersion,
        },
        logger: options.logger,
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
    this.connection.on("inbound", () => {
      this.status.lastInboundAt = Date.now();
      this.publishStatus();
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
      this.handleDownstreamMessage(message).catch((error) => {
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

  private getSessionDeletionRuntime(): SessionDeletionRuntime["subagent"] | null {
    return (this.runtime as Partial<SessionDeletionRuntime>).subagent ?? null;
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

  async handleDownstreamMessage(raw: unknown): Promise<void> {
    if (!this.connection.isConnected()) {
      this.options.logger.warn("runtime.downstream_ignored_no_connection");
      return;
    }
    if (this.connection.getState() !== "READY") {
      this.options.logger.warn("runtime.downstream_ignored_not_ready", {
        state: this.connection.getState(),
      });
      return;
    }
    const startedAt = Date.now();
    const fields = extractDownstreamLogFields(raw);
    logDebug(this.options.logger, "runtime.downstream.received", fields as Record<string, unknown>);
    const normalized = normalizeDownstreamMessage(raw, this.options.logger);
    if (!normalized.ok) {
      this.options.logger.warn("runtime.downstream_ignored_non_protocol", {
        ...fields,
        errorCode: normalized.error.code,
        stage: normalized.error.stage,
        field: normalized.error.field,
        errorMessage: normalized.error.message,
      });
      this.sendToolError({
        type: "tool_error",
        welinkSessionId: fields.welinkSessionId,
        toolSessionId: fields.toolSessionId,
        error: normalized.error.message,
      }, {
        gatewayMessageId: fields.gatewayMessageId,
        action: fields.action,
        welinkSessionId: fields.welinkSessionId,
        toolSessionId: fields.toolSessionId,
      });
      return;
    }

    if (normalized.value.type === "status_query") {
      this.options.logger.info("runtime.status_query.received", fields as Record<string, unknown>);
      const message: StatusResponseMessage = {
        type: "status_response",
        opencodeOnline: this.running && this.connection.isConnected(),
      };
      this.connection.send(message, {
        gatewayMessageId: fields.gatewayMessageId,
        action: "status_query",
      });
      this.options.logger.info("runtime.status_query.responded", {
        ...fields,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    this.options.logger.info("runtime.invoke.received", {
      ...fields,
      action: normalized.value.action,
      welinkSessionId: normalized.value.welinkSessionId,
      toolSessionId: getInvokeToolSessionId(normalized.value),
    });
    const invokeContext: UpstreamSendContext = {
      gatewayMessageId: fields.gatewayMessageId,
      action: normalized.value.action,
      welinkSessionId: normalized.value.welinkSessionId,
      toolSessionId: getInvokeToolSessionId(normalized.value),
    };
    const invokeResult = await this.handleInvoke(normalized.value, invokeContext);
    if (invokeResult.success) {
      this.options.logger.info("runtime.invoke.completed", {
        ...fields,
        action: normalized.value.action,
        welinkSessionId: normalized.value.welinkSessionId,
        toolSessionId: getInvokeToolSessionId(normalized.value),
        latencyMs: Date.now() - startedAt,
      });
      return;
    }
    this.options.logger.warn("runtime.invoke.failed", {
      ...fields,
      action: normalized.value.action,
      welinkSessionId: normalized.value.welinkSessionId,
      toolSessionId: getInvokeToolSessionId(normalized.value),
      latencyMs: Date.now() - startedAt,
      reason: invokeResult.reason,
    });
  }

  private async handleInvoke(
    message: InvokeMessage,
    context: UpstreamSendContext,
  ): Promise<{ success: boolean; reason?: string }> {
    switch (message.action) {
      case "chat":
        if (await this.handleChat(message, context)) {
          return { success: true };
        }
        return { success: false, reason: "chat_failed" };
      case "create_session":
        if (await this.handleCreateSession(message, context)) {
          return { success: true };
        }
        return { success: false, reason: "create_session_failed" };
      case "close_session":
        if (await this.handleCloseSession(message, context)) {
          return { success: true };
        }
        return { success: false, reason: "close_session_failed" };
      case "abort_session":
        if (await this.handleAbortSession(message, context)) {
          return { success: true };
        }
        return { success: false, reason: "abort_session_failed" };
      case "permission_reply":
      case "question_reply":
        this.sendUnsupported(message.action, message.payload.toolSessionId, message.welinkSessionId, context);
        return { success: false, reason: `unsupported_action:${message.action}` };
    }
  }

  private async handleChat(
    message: Extract<InvokeMessage, { action: "chat" }>,
    context: UpstreamSendContext,
  ): Promise<boolean> {
    const chatStartedAt = Date.now();
    const record = this.sessionRegistry.ensure(message.payload.toolSessionId, message.welinkSessionId, {
      updatedAt: chatStartedAt,
    });
    this.clearSessionTermination(record);
    const assistantStream = createAssistantStreamState(record.sessionKey);
    const toolStates = new Map<string, ToolPartState>();
    const startedAt = chatStartedAt;
    const chatRequestId = randomUUID();
    const configuredTimeoutMs = this.options.account.runTimeoutMs;
    const selectedModel = createSelectedModelState();
    const {
      effectiveConfig,
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
    const canExecute = pathSelection.canExecute;
    const executionPath = pathSelection.executionPath;
    const streamMode = pathSelection.streamMode;
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
    this.sendUserMessage(record, message.payload.text, context);
    this.sendSessionUpdated(record, context);
    this.sendToolEvent({
      type: "tool_event",
      toolSessionId: record.toolSessionId,
      event: buildBusyEvent(record.toolSessionId),
    }, context);
    this.logChatPathSelected({
      toolSessionId: record.toolSessionId,
      welinkSessionId: record.welinkSessionId,
      sessionKey: record.sessionKey,
      configuredTimeoutMs,
      executionPath,
      streamMode,
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
      streamingEnabled,
      streamingSource,
      chatRequestId,
      retryAttempt: 0,
    });
    let retryAttempt: RetryAttempt = 0;
    let lastErrorMessage: string | null = null;
    let lastErrorExtra: Record<string, unknown> | undefined;

    while (true) {
      if (
        !canExecute ||
        !this.runtime.channel?.routing?.resolveAgentRoute ||
        !this.runtime.channel?.reply
      ) {
        lastErrorMessage = pathSelection.reason;
        lastErrorExtra = {
          canExecute,
          hasRouteResolver,
          hasReplyRuntime,
        };
        break;
      }

      const replyRuntime = this.runtime.channel.reply as ReplyRuntimeCapabilities;
      const route = this.buildChatRoute(effectiveConfig, record);
      const ctxPayload = this.buildChatInboundContext({
        effectiveConfig,
        record,
        routeAccountId: route.accountId,
        runtimeReply: replyRuntime,
        text: message.payload.text,
      });
      const prefixContext = getReplyPrefixContext(effectiveConfig, route.agentId);
      const { onModelSelected, ...bufferedDispatcherOptions } = channelRuntime.createReplyPrefixOptions({
        cfg: effectiveConfig,
        agentId: route.agentId,
        channel: "message-bridge",
        accountId: this.options.account.accountId,
      });
      const dispatcherFactoryParams: Record<string, unknown> = {
        responsePrefix: prefixContext.responsePrefix,
        responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      };
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
          streamingEnabled,
          streamingSource,
          provider: selection.provider,
          model: selection.model,
          thinkLevel: selection.thinkLevel ?? null,
        });
        onModelSelected?.(selection);
      };
      const projector = new GatewayReplyProjector({
        streamingEnabled,
        onPartialReply: (text) => {
          assistantStream.latestPartialText = text;
          this.handleAssistantPartialReply({
            toolSessionId: record.toolSessionId,
            sessionKey: record.sessionKey,
            chatRequestId,
            retryAttempt,
            startedAt,
            state: assistantStream,
            text,
            context,
          });
        },
        onReasoningStream: (text) => {
          this.handleAssistantReasoningStream(record.toolSessionId, assistantStream, text, context);
        },
        onToolDeliver: (payloadText) => {
          this.handleToolDeliver(record, payloadText, context);
        },
        onBlockObserved: (payloadText) => {
          logDebug(this.options.logger, "bridge.chat.block_observed", {
            toolSessionId: record.toolSessionId,
            sessionKey: record.sessionKey,
            chatRequestId,
            retryAttempt,
            blockTextLength: payloadText.length,
          });
        },
      });
      const executorSelection = this.selectReplyExecutor(replyRuntime);
      const executor = this.createReplyExecutor(executorSelection);
      let executionResult: ReplyExecutionResult | null = null;

      try {
        await executor.execute({
          runtimeReply: replyRuntime,
          effectiveConfig,
          ctxPayload,
          dispatcherFactoryParams,
          bufferedDispatcherOptions,
          configuredTimeoutMs,
          agentId: route.agentId,
          callbacks: {
            onAgentRunStart: (runId) => {
              this.trackSessionRunId(record.sessionKey, runId);
            },
            onModelSelected: handleModelSelected,
            onPartialReply: projector.onPartialReply,
            onReasoningStream: projector.onReasoningStream,
            onDeliver: projector.onDeliver,
          },
        });
        projector.markDispatcherReturned();
        executionResult = projector.buildResult({
          executionPath: "runtime_reply",
          executorType: executor.type,
          fallbackReason: executorSelection.fallbackReason,
          latestPartialText: assistantStream.latestPartialText,
        });
        this.logDispatcherReturned({
          toolSessionId: record.toolSessionId,
          sessionKey: record.sessionKey,
          configuredTimeoutMs,
          executionPath: "runtime_reply",
          streamMode,
          streamingEnabled,
          streamingSource,
          chatRequestId,
          retryAttempt,
          result: executionResult,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (retryAttempt === 0 && this.shouldRetryBeforeFirstPartialTimeout(errorMessage, assistantStream)) {
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
            streamingEnabled,
            streamingSource,
            chatRequestId,
            retryAttempt,
          });
          continue;
        }
        lastErrorMessage = errorMessage;
        const partialExecutionResult = executionResult ?? projector.snapshot({
          executionPath: "runtime_reply",
          executorType: executor.type,
          fallbackReason: executorSelection.fallbackReason,
          latestPartialText: assistantStream.latestPartialText,
        });
        lastErrorExtra = this.buildReplyExecutionExtra(partialExecutionResult);
        break;
      }
      if (this.isSessionTerminated(record)) {
        this.clearActiveToolSession(record.sessionKey);
        return true;
      }
      const replyExecution = executionResult ?? projector.buildResult({
        executionPath: "runtime_reply",
        executorType: executor.type,
        fallbackReason: executorSelection.fallbackReason,
        latestPartialText: assistantStream.latestPartialText,
      });
      const outcome = this.classifyReplyOutcome({
        replyExecution,
        assistantStream,
        caughtErrorMessage: null,
      });
      if (!outcome.shouldEmitAssistant || outcome.finalText === null) {
        lastErrorMessage = outcome.errorMessage ?? "assistant_response_missing_text";
        lastErrorExtra = this.buildReplyExecutionExtra(replyExecution);
        break;
      }
      const finalReconciled =
        replyExecution.pendingFinalText !== null
        && replyExecution.pendingFinalText !== (assistantStream.latestPartialText ?? "");
      this.sendAssistantFinalResponse(
        record.toolSessionId,
        assistantStream,
        outcome.finalText,
        context,
      );
      record.updatedAt = Date.now();
      this.sendAssistantCompleted(record.toolSessionId, assistantStream, context);
      this.sendSessionUpdated(record, context);
      this.logChatCompleted({
        toolSessionId: record.toolSessionId,
        sessionKey: record.sessionKey,
        configuredTimeoutMs,
        startedAt,
        assistantStream,
        selectedModel,
        executionPath: "runtime_reply",
        streamMode,
        streamingEnabled,
        streamingSource,
        chatRequestId,
        retryAttempt,
        finalReconciled,
        responseLength: outcome.finalText.length,
        finalText: outcome.finalText,
        responseSource: outcome.responseSource,
        extra: this.buildReplyExecutionExtra(replyExecution),
      });
      this.sendToolEvent({
        type: "tool_event",
        toolSessionId: record.toolSessionId,
        event: buildIdleEvent(record.toolSessionId),
      }, context);
      this.sendToolDone({
        type: "tool_done",
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
      streamingEnabled,
      streamingSource,
      chatRequestId,
      retryAttempt,
      finalReconciled: false,
      error: finalErrorMessage,
      extra: lastErrorExtra,
    });
    this.sendToolEvent({
      type: "tool_event",
      toolSessionId: record.toolSessionId,
      event: buildSessionErrorEvent(record.toolSessionId, finalErrorMessage),
    }, context);
    this.sendToolError({
      type: "tool_error",
      toolSessionId: record.toolSessionId,
      welinkSessionId: context.welinkSessionId,
      error: finalErrorMessage,
    }, context);
    return false;
  }

  private shouldRetryBeforeFirstPartialTimeout(errorMessage: string, assistantStream: AssistantStreamState): boolean {
    const lowered = errorMessage.toLowerCase();
    const isTimeout = lowered.includes("timed out") || lowered.includes("timeout");
    return assistantStream.firstPartialAt === null && isTimeout;
  }

  private buildChatRoute(
    effectiveConfig: OpenClawConfig,
    record: { toolSessionId: string; welinkSessionId?: string },
  ): { agentId: string; accountId: string } {
    return this.runtime.channel!.routing!.resolveAgentRoute({
      cfg: effectiveConfig,
      channel: "message-bridge",
      accountId: this.options.account.accountId,
      peer: {
        kind: "direct",
        id: record.welinkSessionId || record.toolSessionId,
      },
    });
  }

  private buildChatInboundContext(params: {
    effectiveConfig: OpenClawConfig;
    record: { toolSessionId: string; welinkSessionId?: string; sessionKey: string };
    routeAccountId: string;
    runtimeReply: ReplyRuntimeCapabilities;
    text: string;
  }): Record<string, unknown> {
    const envelopeOptions = params.runtimeReply.resolveEnvelopeFormatOptions(params.effectiveConfig);
    const participantId = params.record.welinkSessionId || params.record.toolSessionId;
    const body = params.runtimeReply.formatAgentEnvelope({
      channel: "message-bridge",
      from: `ai-gateway:${participantId}`,
      timestamp: new Date(),
      previousTimestamp: undefined,
      envelope: envelopeOptions,
      body: params.text,
    });

    return params.runtimeReply.finalizeInboundContext({
      Body: body,
      BodyForAgent: params.text,
      RawBody: params.text,
      CommandBody: params.text,
      From: `message-bridge:${participantId}`,
      To: `message-bridge:${params.record.toolSessionId}`,
      SessionKey: params.record.sessionKey,
      AccountId: params.routeAccountId,
      ChatType: "direct",
      ConversationLabel: `ai-gateway:${participantId}`,
      SenderName: "ai-gateway",
      SenderId: participantId,
      Provider: "message-bridge",
      Surface: "message-bridge",
      Timestamp: new Date().toISOString(),
      OriginatingChannel: "message-bridge",
      OriginatingTo: `message-bridge:${params.record.toolSessionId}`,
      CommandAuthorized: false,
    });
  }

  private selectReplyExecutor(runtimeReply: ReplyRuntimeCapabilities): ReplyExecutorSelection {
    if (
      typeof runtimeReply.createReplyDispatcherWithTyping === "function"
      && typeof runtimeReply.dispatchReplyFromConfig === "function"
    ) {
      return {
        executorType: "runtime",
        fallbackReason: null,
      };
    }

    return {
      executorType: "buffered",
      fallbackReason: "runtime_reply_api_unavailable",
    };
  }

  private createReplyExecutor(selection: ReplyExecutorSelection): ReplyExecutor {
    if (selection.executorType === "runtime") {
      return new RuntimeReplyExecutor();
    }
    return new BufferedReplyExecutor();
  }

  private handleToolDeliver(
    record: { sessionKey: string; toolSessionId: string },
    payloadText: string,
    context: UpstreamSendContext,
  ): void {
    if (this.isSessionTerminated(record)) {
      return;
    }

    const activeSession = this.activeToolSessions.get(record.sessionKey);
    const toolCallId = activeSession?.pendingToolResultTarget;
    if (!toolCallId) {
      return;
    }

    const toolState = activeSession.toolStates.get(toolCallId);
    if (!toolState) {
      return;
    }

    const output = payloadText.trim();
    if (output.length === 0) {
      return;
    }

    activeSession.pendingToolResultTarget = null;
    toolState.output = output;
    this.emitToolPartUpdate(record.toolSessionId, toolState, context);
  }

  private buildReplyExecutionExtra(result: ReplyExecutionResult): Record<string, unknown> {
    return {
      executionPath: result.executionPath,
      executorType: result.executorType,
      fallbackReason: result.fallbackReason,
      dispatcherReturned: result.dispatcherReturned,
      deliverCount: result.deliverCount,
      toolDeliverCount: result.deliverKinds.tool,
      blockDeliverCount: result.deliverKinds.block,
      finalDeliverCount: result.deliverKinds.final,
      firstDeliverKind: result.firstDeliverKind,
      firstDeliverTextPreview: result.firstDeliverTextPreview,
      lastDeliverKind: result.lastDeliverKind,
      lastDeliverTextPreview: result.lastDeliverTextPreview,
      pendingFinalText: result.pendingFinalText,
      latestPartialText: result.latestPartialText,
      firstVisibleReplyAt: result.firstVisibleReplyAt,
      hasVisibleBlockText: result.hasVisibleBlockText,
      blockTextCandidate: result.blockTextCandidate,
    };
  }

  private logDispatcherReturned(params: {
    toolSessionId: string;
    sessionKey: string;
    configuredTimeoutMs: number;
    executionPath: ChatExecutionPath;
    streamMode: StreamMode;
    streamingEnabled: boolean;
    streamingSource: StreamingSource;
    chatRequestId: string;
    retryAttempt: RetryAttempt;
    result: ReplyExecutionResult;
  }): void {
    this.options.logger.info("bridge.chat.dispatcher_returned", {
      toolSessionId: params.toolSessionId,
      sessionKey: params.sessionKey,
      configuredTimeoutMs: params.configuredTimeoutMs,
      runTimeoutMs: params.configuredTimeoutMs,
      executionPath: params.executionPath,
      streamMode: params.streamMode,
      streamingEnabled: params.streamingEnabled,
      streamingSource: params.streamingSource,
      chatRequestId: params.chatRequestId,
      retryAttempt: params.retryAttempt,
      ...this.buildReplyExecutionExtra(params.result),
    });
  }

  private async deleteHostSession(record: { sessionKey: string }): Promise<void> {
    const sessionDeletionRuntime = this.getSessionDeletionRuntime();
    if (sessionDeletionRuntime?.deleteSession) {
      await sessionDeletionRuntime.deleteSession({
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
    const createdAt = Date.now();
    const toolSessionId = createToolSessionId();
    const title =
      isRecord(message.payload.metadata) && typeof message.payload.metadata.title === "string" && message.payload.metadata.title.trim()
        ? message.payload.metadata.title.trim()
        : toolSessionId;
    const record = this.sessionRegistry.ensure(toolSessionId, message.welinkSessionId, {
      title,
      createdAt,
      updatedAt: createdAt,
    });
    this.sendSessionUpdated(record, {
      ...context,
      toolSessionId: record.toolSessionId,
      welinkSessionId: message.welinkSessionId,
    });
    const response: SessionCreatedMessage = {
      type: "session_created",
      welinkSessionId: message.welinkSessionId,
      toolSessionId: record.toolSessionId,
      session: {
        sessionId: record.toolSessionId,
      },
    };
    this.connection.send(response, {
      ...context,
      toolSessionId: record.toolSessionId,
      welinkSessionId: message.welinkSessionId,
    });
    return true;
  }

  private async handleCloseSession(
    message: Extract<InvokeMessage, { action: "close_session" }>,
    context: UpstreamSendContext,
  ): Promise<boolean> {
    const record = this.sessionRegistry.get(message.payload.toolSessionId);
    if (!record) {
      this.sendToolError({
        type: "tool_error",
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
        type: "tool_error",
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
        type: "tool_error",
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
        type: "tool_done",
        toolSessionId: message.payload.toolSessionId,
        welinkSessionId: message.welinkSessionId,
      }, context);
      return true;
    } catch (error) {
      this.clearSessionTermination(record);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendToolError({
        type: "tool_error",
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
      type: "tool_error",
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
      action: "chat",
      toolSessionId,
    };
  }

  private sendToolEvent(message: ToolEventMessage, context?: UpstreamSendContext): void {
    const sendContext = this.buildSendContext(message, context);
    logDebug(this.options.logger, "runtime.tool_event.sending", {
      gatewayMessageId: sendContext.gatewayMessageId,
      action: sendContext.action,
      welinkSessionId: sendContext.welinkSessionId,
      toolSessionId: sendContext.toolSessionId,
      eventType: isRecord(message.event) ? asString(message.event.type) : undefined,
    });
    this.connection.send(message, {
      ...sendContext,
      eventType: isRecord(message.event) ? asString(message.event.type) : undefined,
    });
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
      this.connection.send(message, sendContext);
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
      this.connection.send(message, sendContext);
    } catch {
      this.options.logger.warn("runtime.tool_error.skipped_no_connection", {
        gatewayMessageId: sendContext.gatewayMessageId,
        action: sendContext.action,
        welinkSessionId: sendContext.welinkSessionId,
        toolSessionId: sendContext.toolSessionId,
      });
    }
  }

  private handleAssistantPartialReply(params: {
    toolSessionId: string;
    sessionKey: string;
    chatRequestId: string;
    retryAttempt: RetryAttempt;
    startedAt: number;
    state: AssistantStreamState;
    text: string;
    context: UpstreamSendContext;
  }): void {
    const nextText = params.text;
    if (nextText === params.state.accumulatedText) {
      return;
    }

    const now = Date.now();
    params.state.partialCount += 1;
    if (params.state.firstPartialAt === null) {
      params.state.firstPartialAt = now;
      this.options.logger.info("bridge.chat.partial_streaming", {
        toolSessionId: params.toolSessionId,
        sessionKey: params.sessionKey,
        chatRequestId: params.chatRequestId,
        retryAttempt: params.retryAttempt,
        latencyMs: now - params.startedAt,
        partialLength: nextText.length,
      });
    }

    this.ensureAssistantMessageStarted(params.toolSessionId, params.state, params.context);
    this.sendAssistantTextSeedPartUpdated(params.toolSessionId, params.state, params.context);

    if (params.state.accumulatedText.length === 0) {
      this.sendAssistantTextPartUpdated(params.toolSessionId, params.state, nextText, params.context);
      return;
    }

    if (nextText.startsWith(params.state.accumulatedText)) {
      const suffix = nextText.slice(params.state.accumulatedText.length);
      if (suffix.length > 0) {
        this.sendAssistantTextPartDelta(params.toolSessionId, params.state, suffix, params.context);
      }
      params.state.accumulatedText = nextText;
      return;
    }

    this.sendAssistantTextPartUpdated(params.toolSessionId, params.state, nextText, params.context);
  }

  private ensureAssistantMessageStarted(
    toolSessionId: string,
    state: AssistantStreamState,
    context: UpstreamSendContext,
  ): void {
    if (state.seeded) {
      if (!state.stepStarted) {
        this.sendToolEvent({
          type: "tool_event",
          toolSessionId,
          event: buildStepStartPartUpdated(toolSessionId, state.messageId, state.stepStartPartId, {
            time: Date.now(),
          }),
        }, context);
        state.stepStarted = true;
      }
      return;
    }

    this.sendToolEvent({
      type: "tool_event",
      toolSessionId,
      event: buildMessageUpdated(toolSessionId, state.messageId, "assistant", {
        created: state.messageCreatedAt,
      }),
    }, context);
    state.seeded = true;
    this.sendToolEvent({
      type: "tool_event",
      toolSessionId,
      event: buildStepStartPartUpdated(toolSessionId, state.messageId, state.stepStartPartId, {
        time: Date.now(),
      }),
    }, context);
    state.stepStarted = true;
  }

  private sendAssistantFinalResponse(
    toolSessionId: string,
    state: AssistantStreamState,
    text: string,
    context: UpstreamSendContext,
  ): void {
    this.ensureAssistantMessageStarted(toolSessionId, state, context);
    this.sendAssistantTextSeedPartUpdated(toolSessionId, state, context);
    if (state.accumulatedText === text) {
      return;
    }
    this.sendAssistantTextPartUpdated(toolSessionId, state, text, context);
  }

  private sendAssistantTextSeedPartUpdated(
    toolSessionId: string,
    state: AssistantStreamState,
    context: UpstreamSendContext,
  ): void {
    if (state.textSeedUpdated) {
      return;
    }

    this.sendToolEvent({
      type: "tool_event",
      toolSessionId,
      event: buildTextPartUpdated(
        toolSessionId,
        state.messageId,
        state.textPartId,
        "",
        {
          delta: "",
          time: Date.now(),
        },
      ),
    }, context);
    state.textSeedUpdated = true;
  }

  private sendAssistantTextPartUpdated(
    toolSessionId: string,
    state: AssistantStreamState,
    text: string,
    context: UpstreamSendContext,
  ): void {
    state.accumulatedText = text;
    this.sendToolEvent({
      type: "tool_event",
      toolSessionId,
      event: buildTextPartUpdated(
        toolSessionId,
        state.messageId,
        state.textPartId,
        text,
        {
          time: Date.now(),
        },
      ),
    }, context);
  }

  private sendAssistantTextPartDelta(
    toolSessionId: string,
    state: AssistantStreamState,
    delta: string,
    context: UpstreamSendContext,
  ): void {
    this.sendToolEvent({
      type: "tool_event",
      toolSessionId,
      event: buildMessagePartDelta(toolSessionId, state.messageId, state.textPartId, delta),
    }, context);
    state.accumulatedText += delta;
  }

  private classifyReplyOutcome(params: {
    replyExecution: ReplyExecutionResult;
    assistantStream: AssistantStreamState;
    caughtErrorMessage: string | null;
  }): ReplyOutcome {
    if (params.caughtErrorMessage !== null) {
      return {
        kind: "structured_error",
        finalText: null,
        responseSource: "final_missing",
        errorMessage: params.caughtErrorMessage,
        shouldEmitAssistant: false,
        shouldEmitStructuredError: true,
      };
    }

    const pendingFinalText = params.replyExecution.pendingFinalText;
    if (pendingFinalText !== null && pendingFinalText.length > 0) {
      return {
        kind: "assistant_success",
        finalText: pendingFinalText,
        responseSource: params.assistantStream.latestPartialText === null ? "final_only" : "partial_streaming",
        errorMessage: null,
        shouldEmitAssistant: true,
        shouldEmitStructuredError: false,
      };
    }

    const latestPartialText = params.assistantStream.latestPartialText;
    if (latestPartialText !== null && latestPartialText.length > 0) {
      return {
        kind: "assistant_success",
        finalText: latestPartialText,
        responseSource: pendingFinalText === null ? "final_missing" : "partial_streaming",
        errorMessage: null,
        shouldEmitAssistant: true,
        shouldEmitStructuredError: false,
      };
    }

    if (params.replyExecution.hasVisibleBlockText && params.replyExecution.blockTextCandidate !== null) {
      return {
        kind: "assistant_success",
        finalText: params.replyExecution.blockTextCandidate,
        responseSource: "block_fallback",
        errorMessage: null,
        shouldEmitAssistant: true,
        shouldEmitStructuredError: false,
      };
    }

    return {
      kind: "empty_response",
      finalText: null,
      responseSource: "final_missing",
      errorMessage: "assistant_response_missing_text",
      shouldEmitAssistant: false,
      shouldEmitStructuredError: true,
    };
  }

  private sendAssistantCompleted(
    toolSessionId: string,
    state: AssistantStreamState,
    context: UpstreamSendContext,
  ): void {
    if (!state.stepFinished) {
      this.sendToolEvent({
        type: "tool_event",
        toolSessionId,
        event: buildStepFinishPartUpdated(toolSessionId, state.messageId, state.stepFinishPartId, {
          time: Date.now(),
        }),
      }, context);
      state.stepFinished = true;
    }

    this.sendToolEvent({
      type: "tool_event",
      toolSessionId,
      event: buildMessageUpdated(toolSessionId, state.messageId, "assistant", {
        created: state.messageCreatedAt,
        completed: Date.now(),
      }),
    }, context);
  }

  private sendSessionUpdated(
    record: { toolSessionId: string; title: string; createdAt: number; updatedAt: number },
    context: UpstreamSendContext,
  ): void {
    this.sendToolEvent({
      type: "tool_event",
      toolSessionId: record.toolSessionId,
      event: buildSessionUpdated(record.toolSessionId, {
        id: record.toolSessionId,
        title: record.title,
        time: {
          created: record.createdAt,
          updated: record.updatedAt,
        },
      }),
    }, context);
  }

  private sendUserMessage(
    record: { toolSessionId: string; updatedAt: number },
    text: string,
    context: UpstreamSendContext,
  ): void {
    const createdAt = Date.now();
    const messageId = `msg_${randomUUID()}`;
    const partId = `prt_${randomUUID()}`;
    this.sendToolEvent({
      type: "tool_event",
      toolSessionId: record.toolSessionId,
      event: buildMessageUpdated(record.toolSessionId, messageId, "user", {
        created: createdAt,
      }),
    }, context);
    this.sendToolEvent({
      type: "tool_event",
      toolSessionId: record.toolSessionId,
      event: buildTextPartUpdated(record.toolSessionId, messageId, partId, text, {
        time: createdAt,
      }),
    }, context);
  }

  private emitToolPartUpdate(toolSessionId: string, toolState: ToolPartState, context: UpstreamSendContext): void {
    if (this.terminatedToolSessionIds.has(toolSessionId) || this.terminatedSessionKeys.has(toolState.sessionKey)) {
      return;
    }
    this.sendToolEvent({
      type: "tool_event",
      toolSessionId,
      event: buildToolPartUpdated({
        toolSessionId,
        time: Date.now(),
        ...toolState,
      }),
    }, context);
  }

  private handleAssistantReasoningStream(
    toolSessionId: string,
    state: AssistantStreamState,
    text: string,
    context: UpstreamSendContext,
  ): void {
    if (text === state.accumulatedReasoning) {
      return;
    }

    this.ensureAssistantMessageStarted(toolSessionId, state, context);
    const now = Date.now();

    if (!state.reasoningSeeded) {
      state.reasoningSeeded = true;
      state.reasoningStartedAt = now;
      this.sendToolEvent({
        type: "tool_event",
        toolSessionId,
        event: buildReasoningPartUpdated(toolSessionId, state.messageId, state.reasoningPartId, "", {
          start: now,
        }),
      }, context);
    }

    if (text.startsWith(state.accumulatedReasoning)) {
      const suffix = text.slice(state.accumulatedReasoning.length);
      if (suffix.length === 0) {
        return;
      }
      this.sendToolEvent({
        type: "tool_event",
        toolSessionId,
        event: buildMessagePartDelta(toolSessionId, state.messageId, state.reasoningPartId, suffix),
      }, context);
      state.accumulatedReasoning = text;
      return;
    }

    state.accumulatedReasoning = text;
    this.sendToolEvent({
      type: "tool_event",
      toolSessionId,
      event: buildReasoningPartUpdated(
        toolSessionId,
        state.messageId,
        state.reasoningPartId,
        text,
        {
          start: state.reasoningStartedAt ?? now,
        },
      ),
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
    if (!isRecord(evt.data)) {
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

    const context = this.buildChatEventContext(activeSession.toolSessionId);
    if (evt.stream !== "tool") {
      return;
    }

    const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
    const toolName = typeof evt.data.name === "string" && evt.data.name.length > 0 ? evt.data.name : "tool";
    const toolCallId =
      typeof evt.data.toolCallId === "string" && evt.data.toolCallId.length > 0
        ? evt.data.toolCallId
        : `tool_${randomUUID()}`;

    this.ensureAssistantMessageStarted(activeSession.toolSessionId, activeSession.assistantStream, context);

    let toolState = activeSession.toolStates.get(toolCallId);
    if (!toolState) {
      const nextToolState: ToolPartState = {
        toolCallId,
        toolName,
        partId: `tool_${randomUUID()}`,
        messageId: activeSession.assistantStream.messageId,
        sessionKey,
        status: "running",
      };
      activeSession.toolStates.set(toolCallId, nextToolState);
      toolState = nextToolState;
    }

    toolState.toolName = toolName;
    toolState.title = extractToolResultTitle(evt.data.meta, toolName) ?? toolState.title;

    if (phase === "start" || phase === "update") {
      toolState.status = "running";
      this.emitToolPartUpdate(activeSession.toolSessionId, toolState, context);
      return;
    }

    if (phase === "result") {
      const isError = evt.data.isError === true;
      toolState.status = isError ? "error" : "completed";
      const directOutput = extractToolResultText(evt.data.output) ?? extractToolResultText(evt.data.result);
      const directError = extractToolResultText(evt.data.error) ?? extractToolResultText(evt.data.result);
      toolState.output = !isError && directOutput ? directOutput : toolState.output;
      toolState.error = isError ? (directError ?? `tool_${toolName}_failed`) : undefined;
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
    canExecute: boolean;
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
    streamingEnabled: boolean;
    streamingSource: StreamingSource;
    chatRequestId: string;
    retryAttempt: RetryAttempt;
    finalReconciled: boolean;
    responseLength: number;
    finalText: string;
    responseSource: "partial_streaming" | "final_only" | "final_missing" | "block_fallback";
    extra?: Record<string, unknown>;
  }): void {
    this.options.logger.info("bridge.chat.completed", {
      ...this.buildChatDiagnostics(params),
      responseLength: params.responseLength,
      finalText: params.finalText,
      responseSource: params.responseSource,
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
      failureStage: params.assistantStream.firstPartialAt === null ? "before_first_partial" : "after_first_partial",
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
      streamingEnabled: params.streamingEnabled,
      streamingSource: params.streamingSource,
      chatRequestId: params.chatRequestId,
      retryAttempt: params.retryAttempt,
      finalReconciled: params.finalReconciled,
      provider: params.selectedModel.provider,
      model: params.selectedModel.model,
      thinkLevel: params.selectedModel.thinkLevel,
      partialCount: params.assistantStream.partialCount,
      firstPartialLatencyMs:
        params.assistantStream.firstPartialAt === null ? null : params.assistantStream.firstPartialAt - params.startedAt,
      totalLatencyMs: Date.now() - params.startedAt,
    };
  }
}
