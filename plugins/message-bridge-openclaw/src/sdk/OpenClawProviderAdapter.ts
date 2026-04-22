import { randomUUID } from "node:crypto";

import type {
  ProviderFact,
  ProviderRun,
  ProviderTerminalResult,
  ThirdPartyAgentProvider,
} from "@agent-plugin/bridge-runtime-sdk";

import { reconcileFinalText } from "../reconcileFinalText.js";
import { resolveEffectiveReplyConfig } from "../resolveEffectiveReplyConfig.js";
import type { BridgeLogger, MessageBridgeResolvedAccount } from "../types.js";
import { SessionRegistry } from "../session/SessionRegistry.js";

type OpenClawConfig = Record<string, unknown>;

type PluginRuntime = {
  channel?: {
    routing?: {
      resolveAgentRoute?(input: unknown): { accountId: string; agentId: string };
    };
    reply?: QuestionReplyRuntime & {
      resolveEnvelopeFormatOptions?(config: unknown): unknown;
      formatAgentEnvelope?(input: unknown): unknown;
      finalizeInboundContext?(input: unknown): unknown;
      dispatchReplyWithBufferedBlockDispatcher?(input: unknown): Promise<void>;
    };
  };
  events?: {
    onAgentEvent?(listener: (evt: ToolAgentEvent) => void): () => boolean;
  };
};

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

type QuestionReplyRuntime = {
  replyQuestion?(params: { sessionKey: string; toolCallId: string; answer: string }): Promise<void>;
  answerQuestion?(params: { sessionKey: string; toolCallId: string; answer: string }): Promise<void>;
  submitQuestionAnswer?(params: { sessionKey: string; toolCallId: string; answer: string }): Promise<void>;
  replyPermission?(params: {
    sessionKey: string;
    permissionId: string;
    response: "once" | "always" | "reject";
  }): Promise<void>;
  answerPermission?(params: {
    sessionKey: string;
    permissionId: string;
    response: "once" | "always" | "reject";
  }): Promise<void>;
  submitPermissionAnswer?(params: {
    sessionKey: string;
    permissionId: string;
    response: "once" | "always" | "reject";
  }): Promise<void>;
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
  output?: string;
  error?: string;
}

interface ActiveRunState {
  toolSessionId: string;
  sessionKey: string;
  runId: string;
  messageId: string;
  textPartId: string;
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
  pendingFinalText: string | null;
  pendingToolResultTarget: string | null;
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
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
  runtime: QuestionReplyRuntime,
  candidates: Array<keyof QuestionReplyRuntime>,
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
  private readonly activeRunsBySessionKey = new Map<string, ActiveRunState>();
  private readonly sessionKeyByRunId = new Map<string, string>();
  private unsubscribeAgentEvents: (() => boolean) | null = null;

  constructor(options: OpenClawProviderAdapterOptions) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    if (this.unsubscribeAgentEvents || !this.options.runtime.events?.onAgentEvent) {
      return;
    }
    this.unsubscribeAgentEvents = this.options.runtime.events.onAgentEvent((evt: ToolAgentEvent) => {
      this.handleRuntimeAgentEvent(evt);
    });
  }

  async dispose(): Promise<void> {
    this.unsubscribeAgentEvents?.();
    this.unsubscribeAgentEvents = null;
  }

  async health(): Promise<{ online: boolean }> {
    return { online: this.options.isOnline() };
  }

  async createSession(): Promise<{ toolSessionId: string }> {
    const toolSessionId = randomUUID();
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
      queue,
      result,
      started: false,
      completed: false,
      abortRequested: false,
      accumulatedText: "",
      pendingFinalText: null,
      pendingToolResultTarget: null,
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

  async replyQuestion(input: {
    traceId: string;
    toolSessionId: string;
    toolCallId: string;
    answer: string;
  }): Promise<{ applied: true }> {
    const record = this.options.sessionRegistry.get(input.toolSessionId);
    if (!record) {
      throw new Error("unknown_tool_session");
    }

    const handled = await callRuntimeMethod(
      this.options.runtime.channel?.reply ?? {},
      ["replyQuestion", "answerQuestion", "submitQuestionAnswer"],
      {
        sessionKey: record.sessionKey,
        toolCallId: input.toolCallId,
        answer: input.answer,
      },
    );
    if (!handled) {
      throw new Error("openclaw_question_reply_not_supported");
    }
    return { applied: true };
  }

  async replyPermission(input: {
    traceId: string;
    toolSessionId: string;
    permissionId: string;
    response: "once" | "always" | "reject";
  }): Promise<{ applied: true }> {
    const record = this.options.sessionRegistry.get(input.toolSessionId);
    if (!record) {
      throw new Error("unknown_tool_session");
    }

    const handled = await callRuntimeMethod(
      this.options.runtime.channel?.reply ?? {},
      ["replyPermission", "answerPermission", "submitPermissionAnswer"],
      {
        sessionKey: record.sessionKey,
        permissionId: input.permissionId,
        response: input.response,
      },
    );
    if (!handled) {
      throw new Error("openclaw_permission_reply_not_supported");
    }
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
    if (activeRun) {
      activeRun.abortRequested = true;
    }

    const replyRuntime = this.options.runtime.channel?.reply ?? {};
    const runtimeHandled = await callRuntimeMethod(replyRuntime, ["abortRun", "cancelRun"], {
      sessionKey: record.sessionKey,
      runId: input.runId,
    });
    if (!runtimeHandled) {
      const subagent = this.options.getSubagentRuntime();
      if (subagent?.deleteSession) {
        await subagent.deleteSession({ sessionKey: record.sessionKey });
      }
    }
    return { applied: true };
  }

  private async runInBackground(
    state: ActiveRunState,
    input: { text: string; assistantId?: string; runId: string; toolSessionId: string },
  ): Promise<void> {
    try {
      const hasRouteResolver = !!this.options.runtime.channel?.routing?.resolveAgentRoute;
      const hasReplyRuntime = !!this.options.runtime.channel?.reply;
      if (hasRouteResolver && hasReplyRuntime) {
        await this.runWithReplyRuntime(state, input.text);
      } else {
        await this.runWithSubagentFallback(state, input.text);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.queue.push({
        type: "session.error",
        toolSessionId: state.toolSessionId,
        error: {
          code: "internal_error",
          message,
        },
        raw: error,
      });
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

  private async runWithReplyRuntime(state: ActiveRunState, text: string): Promise<void> {
    const { createReplyPrefixOptions, normalizeOutboundReplyPayload } = await loadOpenClawPluginSdk();
    const { effectiveConfig } = resolveEffectiveReplyConfig(this.options.config);
    const route = this.options.runtime.channel!.routing!.resolveAgentRoute({
      cfg: effectiveConfig,
      channel: "message-bridge",
      accountId: this.options.account.accountId,
      peer: {
        kind: "direct",
        id: state.toolSessionId,
      },
    });
    const replyRuntime = this.options.runtime.channel!.reply!;
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
          const payload =
            asRecord(rawPayload) ? normalizeOutboundReplyPayload(rawPayload) : normalizeOutboundReplyPayload({});
          await this.handleReplyDeliver(state, payload, info);
        },
        onError: (error) => {
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
      state.queue.push({
        type: "tool.update",
        toolSessionId: state.toolSessionId,
        messageId: state.messageId,
        partId: toolState.partId,
        toolCallId: toolState.toolCallId,
        toolName: toolState.toolName,
        status: toolState.status,
        title: toolState.title,
        output,
      });
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

    this.ensureMessageStarted(state);
    state.accumulatedText += text;
    state.queue.push({
      type: "text.delta",
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
      partId: state.textPartId,
      content: text,
      raw: payload,
    });
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
    state.queue.push({
      type: "text.done",
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
      partId: state.textPartId,
      content: finalText,
    });
    state.queue.push({
      type: "message.done",
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
    });
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
    state.queue.push({
      type: "text.done",
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
      partId: state.textPartId,
      content: finalText,
      raw: state.pendingFinalText,
    });
    state.queue.push({
      type: "message.done",
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
    });
    state.queue.close();
  }

  private ensureMessageStarted(state: ActiveRunState): void {
    if (state.started) {
      return;
    }
    state.started = true;
    state.queue.push({
      type: "message.start",
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
    });
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

    if (evt.stream === "tool") {
      this.handleToolAgentEvent(state, payload);
      return;
    }
    if (evt.stream === "question") {
      this.handleQuestionAgentEvent(state, payload);
      return;
    }
    if (evt.stream === "permission") {
      this.handlePermissionAgentEvent(state, payload);
    }
  }

  private handleToolAgentEvent(state: ActiveRunState, payload: Record<string, unknown>): void {
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
    if (phase === "start") {
      toolState.status = "pending";
    } else if (phase === "result") {
      const isError = payload.isError === true;
      toolState.status = isError ? "error" : "completed";
      toolState.error = isError ? `tool_${toolName}_failed` : undefined;
      state.pendingToolResultTarget = toolCallId;
    } else {
      toolState.status = "running";
    }

    state.queue.push({
      type: "tool.update",
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
      partId: toolState.partId,
      toolCallId,
      toolName,
      status: toolState.status,
      title: toolState.title,
      ...(toolState.output !== undefined ? { output: toolState.output } : {}),
      ...(toolState.error ? { error: toolState.error } : {}),
      raw: payload,
    });
  }

  private handleQuestionAgentEvent(state: ActiveRunState, payload: Record<string, unknown>): void {
    const question = asTrimmedString(payload.question);
    const toolCallId = asTrimmedString(payload.toolCallId);
    if (!question || !toolCallId) {
      return;
    }
    this.ensureMessageStarted(state);
    const options = Array.isArray(payload.options)
      ? payload.options.map((value) => asTrimmedString(value)).filter(Boolean)
      : undefined;
    state.queue.push({
      type: "question.ask",
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
      toolCallId,
      question,
      ...(asTrimmedString(payload.header) ? { header: asTrimmedString(payload.header) } : {}),
      ...(options && options.length > 0 ? { options: options as string[] } : {}),
      context: payload,
      raw: payload,
    });
  }

  private handlePermissionAgentEvent(state: ActiveRunState, payload: Record<string, unknown>): void {
    const permissionId = asTrimmedString(payload.permissionId);
    if (!permissionId) {
      return;
    }
    this.ensureMessageStarted(state);
    state.queue.push({
      type: "permission.ask",
      toolSessionId: state.toolSessionId,
      messageId: state.messageId,
      permissionId,
      ...(asTrimmedString(payload.toolCallId) ? { toolCallId: asTrimmedString(payload.toolCallId) } : {}),
      ...(asTrimmedString(payload.permissionType) ? { permissionType: asTrimmedString(payload.permissionType) } : {}),
      metadata: payload,
      raw: payload,
    });
  }

  private finalizeRun(state: ActiveRunState): void {
    state.completed = true;
    this.activeRunsBySessionKey.delete(state.sessionKey);
    this.sessionKeyByRunId.delete(state.runId);
  }
}
