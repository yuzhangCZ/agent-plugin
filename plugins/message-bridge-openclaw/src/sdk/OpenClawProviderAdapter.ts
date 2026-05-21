import { randomUUID } from "node:crypto";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import type {
  ProviderFact,
  ProviderCommandError,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRuntimeContext,
  ProviderRun,
  ProviderTerminalResult,
  ThirdPartyAgentProvider,
} from "@wecode/bridge-runtime-sdk";

import { reconcileFinalText } from "../reconcileFinalText.js";
import { resolveEffectiveReplyConfig } from "../resolveEffectiveReplyConfig.js";
import type { BridgeLogger, MessageBridgeResolvedAccount } from "../types.js";
import { ApprovalRegistry } from "../runtime/ApprovalRegistry.js";
import { RuntimeApprovalPort } from "../runtime/InteractionPorts.js";
import { SessionRegistry } from "../session/SessionRegistry.js";
import {
  buildMessageDoneFact,
  buildMessageStartFact,
  buildPermissionAskFact,
  buildSessionErrorFact,
  buildThinkingDeltaFact,
  buildThinkingDoneFact,
  buildTextDeltaFact,
  buildTextDoneFact,
  buildToolUpdateFact,
  createToolSessionId,
} from "../session/facts.js";

type SubagentRuntime = {
  run(params: {
    sessionKey: string;
    message: string;
    deliver: boolean;
    idempotencyKey: string;
  }): Promise<{ runId: string }>;
  waitForRun(params: { runId: string; timeoutMs: number }): Promise<{ status: string; error?: string }>;
  getSessionMessages(params: { sessionKey: string; limit: number }): Promise<{ messages: unknown[] }>;
  deleteSession?(params: { sessionKey: string }): Promise<void>;
};

type ToolAgentEvent = {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: unknown;
};

type RuntimeGatewayEvent = {
  event?: string;
  type?: string;
  payload?: unknown;
  data?: unknown;
};

type ReplyRuntime = {
  abortRun?(params: { sessionKey: string; runId?: string }): Promise<void>;
  cancelRun?(params: { sessionKey: string; runId?: string }): Promise<void>;
};

type OpenClawPluginSdkModule = {
  createReplyPrefixOptions(input: unknown): {
    onModelSelected?: (selection: { provider: string; model: string; thinkLevel?: string }) => void;
    [key: string]: unknown;
  };
  normalizeOutboundReplyPayload(input: unknown): Record<string, unknown>;
};

type UsableReplyRuntime = ReplyRuntime & {
  resolveEnvelopeFormatOptions(config: unknown): unknown;
  formatAgentEnvelope(input: unknown): unknown;
  finalizeInboundContext(input: unknown): unknown;
  dispatchReplyWithBufferedBlockDispatcher(input: unknown): Promise<void>;
};

interface AsyncQueueController<T> {
  iterable: AsyncIterable<T>;
  push(value: T): void;
  close(): void;
  fail(error: unknown): void;
}

interface ActiveToolState {
  toolCallId: string;
  toolName: string;
  partId: string;
  title?: string;
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

interface ActiveRunState {
  toolSessionId: string;
  sessionKey: string;
  runId: string;
  messageId: string;
  textPartId: string;
  thinkingPartId: string;
  queue: AsyncQueueController<ProviderFact>;
  result: {
    promise: Promise<ProviderTerminalResult>;
    resolve(value: ProviderTerminalResult): void;
    reject(error: unknown): void;
  };
  started: boolean;
  completed: boolean;
  abortRequested: boolean;
  accumulatedText: string;
  accumulatedThinking: string;
  textDeltaCount: number;
  pendingFinalText: string | null;
  pendingToolResultTarget: string | null;
  streamingEnabled: boolean;
  toolStates: Map<string, ActiveToolState>;
}

export interface OpenClawProviderAdapterOptions {
  account: MessageBridgeResolvedAccount;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  logger: BridgeLogger;
  sessionRegistry: SessionRegistry;
  getSubagentRuntime: () => SubagentRuntime | null;
  isOnline: () => boolean;
  onStreamingOutcome?: (outcome: {
    executionPath: "runtime_reply" | "subagent_fallback";
    streamingEnabled: boolean;
    observedRealChunk: boolean;
  }) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function pickRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return asRecord(value[key]);
}

function hasOwnDefinedProperty(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
}

function pickToolPayload(value: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (hasOwnDefinedProperty(value, key)) {
      return value[key];
    }
  }
  return undefined;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createProviderCommandError(
  code: ProviderCommandError["code"],
  message: string,
  details?: Record<string, unknown>,
): Error & ProviderCommandError {
  const error = new Error(message) as Error & ProviderCommandError;
  error.name = "ProviderCommandError";
  error.code = code;
  error.details = details;
  return error;
}

function createAsyncQueue<T>(): AsyncQueueController<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  let closed = false;
  let failure: unknown;

  const flush = () => {
    while (waiters.length > 0 && values.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) {
        continue;
      }
      waiter.resolve({ value: values.shift() as T, done: false });
    }

    if (failure !== undefined) {
      while (waiters.length > 0) {
        waiters.shift()?.reject(failure);
      }
      return;
    }

    if (closed) {
      while (waiters.length > 0) {
        waiters.shift()?.resolve({ value: undefined, done: true });
      }
    }
  };

  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (values.length > 0) {
              return Promise.resolve({ value: values.shift() as T, done: false });
            }
            if (failure !== undefined) {
              return Promise.reject(failure);
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise<IteratorResult<T>>((resolve, reject) => {
              waiters.push({ resolve, reject });
            });
          },
        };
      },
    },
    push(value: T) {
      if (closed || failure !== undefined) {
        return;
      }
      values.push(value);
      flush();
    },
    close() {
      if (failure !== undefined) {
        return;
      }
      closed = true;
      flush();
    },
    fail(error: unknown) {
      if (closed || failure !== undefined) {
        return;
      }
      failure = error;
      flush();
    },
  };
}

function extractAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string" && message.content.trim().length > 0) {
      return message.content;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    const chunks = message.content
      .map((part) => {
        const item = asRecord(part);
        if (!item) {
          return "";
        }
        if (item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        if (typeof item.content === "string") {
          return item.content;
        }
        return "";
      })
      .filter(Boolean);
    if (chunks.length > 0) {
      return chunks.join("");
    }
  }

  return "";
}

async function callRuntimeMethod<TArgs>(
  runtime: ReplyRuntime,
  candidates: Array<keyof ReplyRuntime>,
  args: TArgs,
): Promise<boolean> {
  for (const key of candidates) {
    const candidate = runtime[key];
    if (typeof candidate !== "function") {
      continue;
    }
    await (candidate as (input: TArgs) => Promise<void>)(args);
    return true;
  }
  return false;
}

async function loadOpenClawPluginSdk(): Promise<OpenClawPluginSdkModule> {
  const [channelRuntime, replyPayload] = await Promise.all([
    import("openclaw/plugin-sdk/channel-runtime"),
    import("openclaw/plugin-sdk/reply-payload"),
  ]);
  return {
    createReplyPrefixOptions: channelRuntime.createReplyPrefixOptions,
    normalizeOutboundReplyPayload: replyPayload.normalizeOutboundReplyPayload,
  } as OpenClawPluginSdkModule;
}

/**
 * OpenClaw 宿主能力到 SDK Provider SPI 的适配层。
 * @remarks
 * 这里负责把 OpenClaw runtime / subagent 的宿主事件转换成有序 `ProviderFact` 流；
 * SDK core 只消费标准化后的事实与终态，不再直接理解 OpenClaw 私有事件。
 */
export class OpenClawProviderAdapter implements ThirdPartyAgentProvider {
  private readonly options: OpenClawProviderAdapterOptions;
  private readonly approvalRegistry = new ApprovalRegistry();
  private readonly approvalPort: RuntimeApprovalPort;
  private readonly activeRunsBySessionKey = new Map<string, ActiveRunState>();
  private readonly sessionKeyByRunId = new Map<string, string>();
  private outbound: ProviderRuntimeContext["outbound"] | null = null;
  private unsubscribeAgentEvents: (() => boolean) | null = null;
  private unsubscribeGatewayEvents: (() => boolean) | null = null;

  constructor(options: OpenClawProviderAdapterOptions) {
    this.options = options;
    this.approvalPort = new RuntimeApprovalPort(options.runtime);
  }

  async initialize(context?: ProviderRuntimeContext): Promise<void> {
    this.outbound = context?.outbound ?? null;
    if (!this.unsubscribeAgentEvents && this.options.runtime.events?.onAgentEvent) {
      this.unsubscribeAgentEvents = this.options.runtime.events.onAgentEvent((evt) => {
        this.handleRuntimeAgentEvent(evt as ToolAgentEvent);
      });
    }
    if (!this.unsubscribeGatewayEvents) {
      this.unsubscribeGatewayEvents = this.subscribeRuntimeGatewayEvents();
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribeAgentEvents?.();
    this.unsubscribeAgentEvents = null;
    this.unsubscribeGatewayEvents?.();
    this.unsubscribeGatewayEvents = null;
    this.outbound = null;
    this.approvalRegistry.clearAll();
  }

  async health(): Promise<{ online: boolean }> {
    return { online: this.options.isOnline() };
  }

  async createSession(): Promise<{ toolSessionId: string }> {
    const toolSessionId = createToolSessionId();
    this.options.sessionRegistry.ensure(toolSessionId);
    return { toolSessionId };
  }

  async runMessage(input: {
    traceId: string;
    runId: string;
    toolSessionId: string;
    text: string;
    assistantId?: string;
  }): Promise<ProviderRun> {
    const record = this.options.sessionRegistry.ensure(input.toolSessionId);
    const queue = createAsyncQueue<ProviderFact>();
    const result = createDeferred<ProviderTerminalResult>();
    const state: ActiveRunState = {
      toolSessionId: input.toolSessionId,
      sessionKey: record.sessionKey,
      runId: input.runId,
      messageId: `msg_${randomUUID()}`,
      textPartId: `part_${randomUUID()}`,
      thinkingPartId: `part_${randomUUID()}`,
      queue,
      result,
      started: false,
      completed: false,
      abortRequested: false,
      accumulatedText: "",
      accumulatedThinking: "",
      textDeltaCount: 0,
      pendingFinalText: null,
      pendingToolResultTarget: null,
      streamingEnabled: this.options.account.streaming !== false,
      toolStates: new Map(),
    };

    this.activeRunsBySessionKey.set(record.sessionKey, state);
    this.runInBackground(state, input);

    return {
      runId: input.runId,
      facts: queue.iterable,
      result() {
        return result.promise;
      },
    };
  }

  async replyQuestion(_input: ProviderQuestionReplyInput): Promise<{ applied: true }> {
    throw createProviderCommandError("not_supported", "OpenClaw plugin does not support question replies");
  }

  async replyPermission(input: ProviderPermissionReplyInput): Promise<{ applied: true }> {
    const gatewayApproval = this.approvalRegistry.get(input.permissionId);
    if (!gatewayApproval) {
      throw createProviderCommandError("not_found", "Permission approval not found", {
        permissionId: input.permissionId,
      });
    }
    if (gatewayApproval.status !== "pending") {
      throw createProviderCommandError("invalid_input", `Permission approval is already ${gatewayApproval.status}`, {
        permissionId: input.permissionId,
        status: gatewayApproval.status,
      });
    }

    const decision =
      input.reply === "once"
        ? "allow-once"
        : input.reply === "always"
          ? "allow-always"
          : "deny";
    await this.approvalPort.resolve({
      permissionId: input.permissionId,
      decision,
    });
    this.approvalRegistry.markResolved(input.permissionId);
    return { applied: true };
  }

  async closeSession(input: { traceId: string; toolSessionId: string }): Promise<{ applied: true }> {
    const record = this.options.sessionRegistry.get(input.toolSessionId);
    if (!record) {
      throw new Error("unknown_tool_session");
    }

    const activeRun = this.activeRunsBySessionKey.get(record.sessionKey);
    if (activeRun) {
      activeRun.abortRequested = true;
    }
    this.approvalRegistry.clearSession(input.toolSessionId);

    const subagent = this.options.getSubagentRuntime();
    if (subagent?.deleteSession) {
      await subagent.deleteSession({ sessionKey: record.sessionKey });
    }
    this.activeRunsBySessionKey.delete(record.sessionKey);
    this.options.sessionRegistry.delete(input.toolSessionId);
    return { applied: true };
  }

  async abortSession(input: { traceId: string; toolSessionId: string; runId?: string }): Promise<{ applied: true }> {
    const record = this.options.sessionRegistry.get(input.toolSessionId);
    if (!record) {
      throw new Error("unknown_tool_session");
    }

    const activeRun = this.activeRunsBySessionKey.get(record.sessionKey);
    const abortRunId = activeRun?.runId ?? input.runId;
    if (activeRun) {
      this.abortActiveRun(activeRun);
    }
    this.approvalRegistry.clearSession(input.toolSessionId);

    const replyRuntime = this.options.runtime.channel?.reply ?? {};
    try {
      await callRuntimeMethod(replyRuntime, ["abortRun", "cancelRun"], {
        sessionKey: record.sessionKey,
        runId: abortRunId,
      });
    } catch (error) {
      if (!activeRun) {
        throw error;
      }
      this.options.logger.warn("runtime.abort_session.host_abort_failed", {
        toolSessionId: input.toolSessionId,
        sessionKey: record.sessionKey,
        runId: abortRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { applied: true };
  }

  private async runInBackground(
    state: ActiveRunState,
    input: { text: string; assistantId?: string; runId: string; toolSessionId: string },
  ): Promise<void> {
    try {
      const hasRouteResolver = !!this.options.runtime.channel?.routing?.resolveAgentRoute;
      const hasReplyRuntime = this.hasUsableReplyRuntime();
      if (hasRouteResolver && hasReplyRuntime) {
        await this.runWithReplyRuntime(state, input.text);
      } else {
        await this.runWithSubagentFallback(state, input.text);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.queue.push(buildSessionErrorFact({
        toolSessionId: state.toolSessionId,
        error: {
          code: "internal_error",
          message,
        },
        raw: error,
      }));
      state.queue.close();
      state.result.resolve({
        outcome: state.abortRequested ? "aborted" : "failed",
        error: state.abortRequested
          ? undefined
          : {
              code: "internal_error",
              message,
            },
      });
      this.finalizeRun(state);
    }
  }

  private hasUsableReplyRuntime(): boolean {
    const reply = this.options.runtime.channel?.reply;
    return !!(
      reply &&
      typeof reply.resolveEnvelopeFormatOptions === "function" &&
      typeof reply.formatAgentEnvelope === "function" &&
      typeof reply.finalizeInboundContext === "function" &&
      typeof reply.dispatchReplyWithBufferedBlockDispatcher === "function"
    );
  }

  private async runWithReplyRuntime(state: ActiveRunState, text: string): Promise<void> {
    const { createReplyPrefixOptions, normalizeOutboundReplyPayload } = await loadOpenClawPluginSdk();
    const { effectiveConfig, streamingEnabled } = resolveEffectiveReplyConfig(this.options.config);
    state.streamingEnabled = this.options.account.streaming !== false && streamingEnabled;
    const resolveAgentRoute = this.options.runtime.channel?.routing?.resolveAgentRoute;
    if (!resolveAgentRoute) {
      throw new Error("openclaw_route_resolver_unavailable");
    }
    const route = resolveAgentRoute({
      cfg: effectiveConfig,
      channel: "message-bridge",
      accountId: this.options.account.accountId,
      peer: {
        kind: "direct",
        id: state.toolSessionId,
      },
    });
    const replyRuntime = this.options.runtime.channel!.reply as UsableReplyRuntime;
    const envelopeOptions = replyRuntime.resolveEnvelopeFormatOptions(effectiveConfig);
    const body = replyRuntime.formatAgentEnvelope({
      channel: "message-bridge",
      from: `ai-gateway:${state.toolSessionId}`,
      timestamp: new Date(),
      previousTimestamp: undefined,
      envelope: envelopeOptions,
      body: text,
    });
    const ctxPayload = replyRuntime.finalizeInboundContext({
      Body: body,
      BodyForAgent: text,
      RawBody: text,
      CommandBody: text,
      From: `message-bridge:${state.toolSessionId}`,
      To: `message-bridge:${state.toolSessionId}`,
      SessionKey: state.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct",
      ConversationLabel: `ai-gateway:${state.toolSessionId}`,
      SenderName: "ai-gateway",
      SenderId: state.toolSessionId,
      Provider: "message-bridge",
      Surface: "message-bridge",
      Timestamp: new Date().toISOString(),
      OriginatingChannel: "message-bridge",
      OriginatingTo: `message-bridge:${state.toolSessionId}`,
      CommandAuthorized: false,
    });
    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg: effectiveConfig,
      agentId: route.agentId,
      channel: "message-bridge",
      accountId: this.options.account.accountId,
    });

    await replyRuntime.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: effectiveConfig,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (rawPayload: unknown, info: { kind: "tool" | "block" | "final" }) => {
          this.logChatRawEvent({
            source: "runtime_reply_dispatcher",
            eventName: info.kind === "block" ? "onBlock" : info.kind === "final" ? "onFinal" : "onTool",
            toolSessionId: state.toolSessionId,
            sessionKey: state.sessionKey,
            payload: rawPayload,
          });
          const payload =
            asRecord(rawPayload) ? normalizeOutboundReplyPayload(rawPayload) : normalizeOutboundReplyPayload({});
          await this.handleReplyDeliver(state, payload, info);
        },
        onError: (error: unknown) => {
          throw error;
        },
      },
      replyOptions: {
        onAgentRunStart: (runId: string) => {
          state.runId = runId;
          this.sessionKeyByRunId.set(runId, state.sessionKey);
        },
        onModelSelected,
        timeoutOverrideSeconds: Math.ceil(this.options.account.runTimeoutMs / 1000),
      },
    });

    this.completeTextMessage(state);
    this.options.onStreamingOutcome?.({
      executionPath: "runtime_reply",
      streamingEnabled: state.streamingEnabled,
      observedRealChunk: state.textDeltaCount > 0,
    });
    state.result.resolve({
      outcome: state.abortRequested ? "aborted" : "completed",
    });
    this.finalizeRun(state);
  }

  private async handleReplyDeliver(
    state: ActiveRunState,
    payload: Record<string, unknown>,
    info: { kind: "tool" | "block" | "final" },
  ): Promise<void> {
    if (state.abortRequested || state.completed) {
      return;
    }

    if (info.kind === "tool") {
      const toolCallId = state.pendingToolResultTarget;
      if (!toolCallId) {
        return;
      }
      const toolState = state.toolStates.get(toolCallId);
      if (!toolState) {
        return;
      }
      const output = asTrimmedString(payload.text);
      if (!output) {
        return;
      }
      toolState.output = output;
      this.ensureMessageStarted(state);
      state.queue.push(buildToolUpdateFact({
        toolSessionId: state.toolSessionId,
        messageId: state.messageId,
        partId: toolState.partId,
        toolCallId: toolState.toolCallId,
        toolName: toolState.toolName,
        status: toolState.status,
        title: toolState.title,
        output,
      }));
      return;
    }

    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text) {
      return;
    }

    if (info.kind === "final") {
      state.pendingFinalText = text;
      return;
    }

    if (!state.streamingEnabled) {
      state.accumulatedText += text;
      return;
    }

    this.ensureMessageStarted(state);
    state.accumulatedText += text;
    state.textDeltaCount += 1;
    state.queue.push(buildTextDeltaFact({
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
      partId: state.textPartId,
      content: text,
      raw: payload,
    }));
  }

  private async runWithSubagentFallback(state: ActiveRunState, text: string): Promise<void> {
    const subagent = this.options.getSubagentRuntime();
    if (!subagent) {
      throw new Error("openclaw_runtime_missing_reply_executor");
    }

    const run = await subagent.run({
      sessionKey: state.sessionKey,
      message: text,
      deliver: false,
      idempotencyKey: `sdk:${state.runId}`,
    });
    state.runId = run.runId;
    this.sessionKeyByRunId.set(run.runId, state.sessionKey);

    const wait = await subagent.waitForRun({
      runId: run.runId,
      timeoutMs: this.options.account.runTimeoutMs,
    });
    if (wait.status !== "ok") {
      throw new Error(wait.error ?? `subagent_${wait.status}`);
    }

    const session = await subagent.getSessionMessages({
      sessionKey: state.sessionKey,
      limit: 50,
    });
    const finalText = extractAssistantText(session.messages) || "(empty response)";
    this.ensureMessageStarted(state);
    state.accumulatedText = finalText;
    state.queue.push(buildTextDoneFact({
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
      partId: state.textPartId,
      content: finalText,
    }));
    state.queue.push(buildMessageDoneFact({
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
    }));
    state.queue.close();
    state.result.resolve({
      outcome: state.abortRequested ? "aborted" : "completed",
    });
    this.finalizeRun(state);
  }

  private completeTextMessage(state: ActiveRunState): void {
    this.ensureMessageStarted(state);
    const reconciliation = reconcileFinalText(state.accumulatedText, state.pendingFinalText);
    const finalText = reconciliation.finalText || state.accumulatedText || "(empty response)";
    state.accumulatedText = finalText;
    state.queue.push(buildTextDoneFact({
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
      partId: state.textPartId,
      content: finalText,
      raw: state.pendingFinalText,
    }));
    state.queue.push(buildMessageDoneFact({
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
    }));
    state.queue.close();
  }

  private ensureMessageStarted(state: ActiveRunState): void {
    if (state.started) {
      return;
    }
    state.started = true;
    state.queue.push(buildMessageStartFact({
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
    }));
  }

  private subscribeRuntimeGatewayEvents(): (() => boolean) | null {
    const events = this.options.runtime.events;
    const subscribe = events?.onGatewayEvent ?? events?.onSystemEvent ?? events?.onEvent;
    if (!subscribe) {
      return null;
    }

    return subscribe((evt) => {
      this.handleRuntimeGatewayEvent(evt as RuntimeGatewayEvent).catch((error) => {
        this.options.logger.warn("runtime.gateway_event.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  private async handleRuntimeGatewayEvent(evt: RuntimeGatewayEvent): Promise<void> {
    const eventName = typeof evt.event === "string" ? evt.event : typeof evt.type === "string" ? evt.type : "";
    const payload = asRecord(evt.payload) ?? asRecord(evt.data);
    if (!eventName || !payload) {
      return;
    }

    if (eventName === "exec.approval.requested") {
      await this.handleApprovalRequested(eventName, payload);
      return;
    }

    if (eventName === "exec.approval.resolved") {
      this.handleApprovalResolved(payload);
      return;
    }

  }

  private async handleApprovalRequested(eventName: string, payload: Record<string, unknown>): Promise<void> {
    const permissionId = asTrimmedString(payload.id) ?? asTrimmedString(payload.permissionId);
    const toolSessionId = this.extractToolSessionIdFromRuntimePayload(payload);
    if (!permissionId || !toolSessionId) {
      return;
    }

    const messageId = asTrimmedString(payload.messageId) ?? `msg_${randomUUID()}`;
    const metadata = pickRecord(payload, "metadata") ?? pickRecord(payload, "meta");
    const title = asTrimmedString(payload.title);
    const expiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : undefined;
    const record = this.approvalRegistry.upsertPending({
      toolSessionId,
      permissionId,
      title,
      messageId,
      metadata,
      expiresAt,
    });
    this.options.sessionRegistry.ensure(toolSessionId);

    await this.emitRuntimeOutboundFacts({
      toolSessionId,
      messageId,
      trigger: eventName,
      facts: [
        buildMessageStartFact({ toolSessionId, messageId, raw: payload }),
        buildPermissionAskFact({
          toolSessionId,
          messageId,
          partId: `part_${randomUUID()}`,
          permissionId,
          permissionType: asTrimmedString(payload.type) ?? asTrimmedString(payload.permission),
          ...(record.title ? { title: record.title } : {}),
          metadata: {
            ...(record.metadata ?? {}),
            ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
            status: record.status,
            sourceEvent: eventName,
          },
          raw: payload,
        }),
        buildMessageDoneFact({ toolSessionId, messageId }),
      ],
    });
  }

  private handleApprovalResolved(payload: Record<string, unknown>): void {
    const permissionId = asTrimmedString(payload.id) ?? asTrimmedString(payload.permissionId);
    if (!permissionId) {
      return;
    }
    this.approvalRegistry.markResolved(permissionId);
  }

  private async emitRuntimeOutboundFacts(input: {
    toolSessionId: string;
    messageId: string;
    trigger: string;
    facts: ProviderFact[];
  }): Promise<void> {
    if (!this.outbound) {
      return;
    }
    await this.outbound.emitOutboundMessage({
      toolSessionId: input.toolSessionId,
      messageId: input.messageId,
      trigger: input.trigger,
      facts: this.iterateFacts(input.facts),
    });
  }

  private async *iterateFacts(facts: ProviderFact[]): AsyncIterable<ProviderFact> {
    for (const fact of facts) {
      yield fact;
    }
  }

  private extractToolSessionIdFromRuntimePayload(payload: Record<string, unknown>): string | undefined {
    const metadata = pickRecord(payload, "metadata");
    const tool = pickRecord(payload, "tool");
    return (
      asTrimmedString(payload.toolSessionId) ??
      asTrimmedString(payload.sessionID) ??
      asTrimmedString(payload.sessionId) ??
      asTrimmedString(metadata?.toolSessionId) ??
      asTrimmedString(metadata?.sessionID) ??
      asTrimmedString(tool?.sessionID)
    );
  }

  private handleRuntimeAgentEvent(evt: ToolAgentEvent): void {
    const payload = asRecord(evt.data);
    if (!payload) {
      return;
    }

    const directSessionKey = asTrimmedString(evt.sessionKey);
    const mappedSessionKey = asTrimmedString(evt.runId) ? this.sessionKeyByRunId.get(evt.runId!) : undefined;
    const sessionKey = directSessionKey ?? mappedSessionKey;
    if (!sessionKey) {
      return;
    }

    const state = this.activeRunsBySessionKey.get(sessionKey);
    if (!state || state.completed) {
      return;
    }

    this.logChatRawEvent({
      source: "runtime_agent_event",
      eventName: typeof evt.stream === "string" ? evt.stream : "unknown",
      toolSessionId: state.toolSessionId,
      sessionKey,
      payload: evt,
    });

    if (evt.stream === "tool") {
      this.handleToolAgentEvent(state, payload);
      return;
    }
    if (evt.stream === "assistant") {
      this.handleAssistantAgentEvent(state, payload);
      return;
    }
    if (evt.stream === "reasoning") {
      this.handleReasoningAgentEvent(state, payload);
      return;
    }
  }

  private handleToolAgentEvent(state: ActiveRunState, payload: Record<string, unknown>): void {
    if (state.abortRequested || state.completed) {
      return;
    }

    this.ensureMessageStarted(state);
    const toolCallId = asTrimmedString(payload.toolCallId) ?? `tool_${randomUUID()}`;
    const toolName = asTrimmedString(payload.name) ?? "tool";
    const phase = asTrimmedString(payload.phase) ?? "update";
    let toolState = state.toolStates.get(toolCallId);
    if (!toolState) {
      toolState = {
        toolCallId,
        toolName,
        partId: `tool_${randomUUID()}`,
        status: "pending",
      };
      state.toolStates.set(toolCallId, toolState);
    }

    toolState.toolName = toolName;
    toolState.title = asTrimmedString(payload.title) ?? asTrimmedString(asRecord(payload.meta)?.summary) ?? toolName;
    const directInput = pickToolPayload(payload, ["input", "args"]);
    if (directInput !== undefined) {
      toolState.input = directInput;
    }

    if (phase === "start" || phase === "update") {
      toolState.status = "running";
    } else if (phase === "result") {
      const isError = payload.isError === true;
      toolState.status = isError ? "error" : "completed";
      const directOutput = pickToolPayload(payload, ["output", "result"]);
      const directError = pickToolPayload(payload, ["error", "result"]);
      toolState.output = !isError && directOutput !== undefined ? directOutput : toolState.output;
      toolState.error = isError ? (directError ?? `tool_${toolName}_failed`) : undefined;
      state.pendingToolResultTarget = toolCallId;
    } else {
      toolState.status = "running";
    }

    state.queue.push(buildToolUpdateFact({
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
      partId: toolState.partId,
      toolCallId,
      toolName,
      status: toolState.status,
      title: toolState.title,
      ...(toolState.input !== undefined ? { input: toolState.input } : {}),
      ...(toolState.output !== undefined ? { output: toolState.output } : {}),
      ...(toolState.error ? { error: toolState.error } : {}),
      raw: payload,
    }));
  }

  private handleAssistantAgentEvent(state: ActiveRunState, payload: Record<string, unknown>): void {
    if (state.abortRequested || state.completed) {
      return;
    }

    const fullText = typeof payload.text === "string" ? payload.text : "";
    let deltaText = typeof payload.delta === "string" ? payload.delta : "";

    if (fullText.startsWith(state.accumulatedText)) {
      const suffix = fullText.slice(state.accumulatedText.length);
      if (suffix.length > 0) {
        deltaText = suffix;
      } else if (deltaText.length === 0 || state.accumulatedText.endsWith(deltaText)) {
        return;
      }
    } else if (deltaText.length === 0) {
      return;
    }

    if (deltaText.length === 0) {
      return;
    }

    const nextText = fullText || `${state.accumulatedText}${deltaText}`;
    state.accumulatedText = nextText;
    if (!state.streamingEnabled) {
      return;
    }

    this.ensureMessageStarted(state);
    state.textDeltaCount += 1;
    state.queue.push(buildTextDeltaFact({
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
      partId: state.textPartId,
      content: deltaText,
      raw: payload,
    }));
  }

  private handleReasoningAgentEvent(state: ActiveRunState, payload: Record<string, unknown>): void {
    if (state.abortRequested || state.completed) {
      return;
    }

    const phase = asTrimmedString(payload.phase) ?? "delta";
    const deltaText = typeof payload.delta === "string"
      ? payload.delta
      : typeof payload.text === "string"
        ? payload.text
        : "";
    const shouldEmitReasoningDelta =
      deltaText.length > 0 &&
      (phase !== "finish" && phase !== "result" || state.accumulatedThinking.length === 0);
    if (shouldEmitReasoningDelta) {
      state.accumulatedThinking += deltaText;
      this.ensureMessageStarted(state);
      state.queue.push(buildThinkingDeltaFact({
        toolSessionId: state.toolSessionId,
        messageId: state.messageId,
        partId: state.thinkingPartId,
        content: deltaText,
        raw: payload,
      }));
    }

    if (phase === "finish" || phase === "result") {
      this.ensureMessageStarted(state);
      state.queue.push(buildThinkingDoneFact({
        toolSessionId: state.toolSessionId,
        messageId: state.messageId,
        partId: state.thinkingPartId,
        content: state.accumulatedThinking,
        raw: payload,
      }));
    }
  }

  private finalizeRun(state: ActiveRunState): void {
    state.completed = true;
    if (this.activeRunsBySessionKey.get(state.sessionKey) === state) {
      this.activeRunsBySessionKey.delete(state.sessionKey);
    }
    if (this.sessionKeyByRunId.get(state.runId) === state.sessionKey) {
      this.sessionKeyByRunId.delete(state.runId);
    }
  }

  /**
   * abort_session 的本地收口入口。
   * @remarks OpenClaw 的宿主取消能力是 best-effort；这里必须先关闭本地输出边界，
   * 确保 SDK 能投影 `tool_done`，并抑制宿主晚到的流式输出。
   */
  private abortActiveRun(state: ActiveRunState): void {
    if (state.completed) {
      return;
    }
    state.abortRequested = true;
    state.queue.close();
    state.result.resolve({ outcome: "aborted" });
    this.finalizeRun(state);
  }

  private logChatRawEvent(params: {
    source: string;
    eventName: string;
    toolSessionId?: string;
    sessionKey?: string;
    payload: unknown;
  }): void {
    if (!this.options.account.debug) {
      return;
    }
    const log = this.options.logger.debug ?? this.options.logger.info;
    log.call(this.options.logger, "bridge.chat.raw_event", {
      source: params.source,
      eventName: params.eventName,
      toolSessionId: params.toolSessionId,
      sessionKey: params.sessionKey,
      payload: params.payload,
    });
  }
}
