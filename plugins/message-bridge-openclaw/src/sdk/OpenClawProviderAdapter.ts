/* eslint-disable max-lines -- OpenClaw provider adapter 集中承载 runtime reply、事件翻译和 SDK provider contract 映射，后续拆分单独处理。 */
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import type {
  ProviderFact,
  ProviderAbortSessionInput,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRuntimeContext,
  ProviderRun,
  ProviderTerminalResult,
  ThirdPartyAgentProvider,
} from "@wecode/bridge-runtime-sdk";

import { reconcileFinalText } from "../reconcileFinalText.js";
import { resolveEffectiveReplyConfig } from "../resolveEffectiveReplyConfig.js";
import { ApprovalRegistry } from "../runtime/ApprovalRegistry.js";
import { RuntimeApprovalPort } from "../runtime/InteractionPorts.js";
import {
  buildMessageDoneFact,
  buildMessageStartFact,
  buildPermissionAskFact,
  buildSessionErrorFact,
  buildSessionTitleFact,
  buildThinkingDeltaFact,
  buildThinkingDoneFact,
  buildTextDeltaFact,
  buildTextDoneFact,
  buildToolUpdateFact,
  createToolSessionId,
} from "../session/facts.js";
import { asRecord, asTrimmedString } from "../utils/type-guards.js";
import { createAsyncQueue } from "./async-queue.js";
import { createDeferred } from "./deferred.js";
import { extractAssistantText } from "./message-extraction.js";
import type {
  ActiveRunState,
  MessageBridgeRoute,
  OpenClawProviderAdapterOptions,
  RuntimeGatewayEvent,
  ToolAgentEvent,
} from "./provider-adapter-types.js";
import { createProviderCommandError } from "./provider-command-error.js";
import {
  asReadyReplyRuntime,
  asReadySessionRuntime,
  callRuntimeMethod,
  loadOpenClawPluginSdk,
  type ReplyAbortRuntime,
} from "./runtime-helpers.js";
import {
  extractToolSessionIdFromRuntimePayload,
  pickRecord,
  pickToolPayload,
} from "./runtime-payload.js";

export type { OpenClawProviderAdapterOptions } from "./provider-adapter-types.js";

function resolvePermissionDecision(reply: ProviderPermissionReplyInput["reply"]): "allow-once" | "allow-always" | "deny" {
  if (reply === "once") {
    return "allow-once";
  }
  if (reply === "always") {
    return "allow-always";
  }
  return "deny";
}

function getRuntimeReplyEventName(kind: "tool" | "block" | "final"): "onTool" | "onBlock" | "onFinal" {
  if (kind === "block") {
    return "onBlock";
  }
  if (kind === "final") {
    return "onFinal";
  }
  return "onTool";
}

function getRuntimeGatewayEventName(evt: RuntimeGatewayEvent): string {
  if (typeof evt.event === "string") {
    return evt.event;
  }
  if (typeof evt.type === "string") {
    return evt.type;
  }
  return "";
}

function getPayloadDeltaText(payload: Record<string, unknown>): string {
  if (typeof payload.delta === "string") {
    return payload.delta;
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  return "";
}

// tool 事件是增量到达的；这里按 toolCallId 保留跨事件累计态，保证 update/result 可以合并成同一个 part。
function getOrCreateToolState(state: ActiveRunState, toolCallId: string, toolName: string): ActiveToolState {
  const existing = state.toolStates.get(toolCallId);
  if (existing) {
    return existing;
  }

  // 同一个 toolCallId 可能多次 update/result；本地状态用于合并 input、output、error。
  const created: ActiveToolState = {
    toolCallId,
    toolName,
    partId: `tool_${randomUUID()}`,
    status: "pending",
  };
  state.toolStates.set(toolCallId, created);
  return created;
}

function getToolTitle(payload: Record<string, unknown>, toolName: string): string {
  return asTrimmedString(payload.title) ?? asTrimmedString(asRecord(payload.meta)?.summary) ?? toolName;
}

// 宿主可能用 input 或 args 表达工具入参；只在本次事件提供有效载荷时刷新累计态。
function mergeToolInput(toolState: ActiveToolState, payload: Record<string, unknown>): void {
  const directInput = pickToolPayload(payload, ["input", "args"]);
  if (directInput !== undefined) {
    toolState.input = directInput;
  }
}

function applyToolResultPhase(
  state: ActiveRunState,
  toolState: ActiveToolState,
  toolCallId: string,
  toolName: string,
  payload: Record<string, unknown>,
): void {
  const isError = payload.isError === true;
  const directOutput = pickToolPayload(payload, ["output", "result"]);
  const directError = pickToolPayload(payload, ["error", "result"]);

  toolState.status = isError ? "error" : "completed";
  toolState.output = !isError && directOutput !== undefined ? directOutput : toolState.output;
  toolState.error = isError ? (directError ?? `tool_${toolName}_failed`) : undefined;
  // 后续 dispatcher tool 文本会补到这个 tool call 上。
  state.pendingToolResultTarget = toolCallId;
}

// 未识别 phase 仍按 running 处理，保持对宿主新增中间态的兼容。
function applyToolPhase(context: {
  state: ActiveRunState,
  toolState: ActiveToolState,
  toolCallId: string,
  toolName: string,
  phase: string,
  payload: Record<string, unknown>,
}): void {
  const { state, toolState, toolCallId, toolName, phase, payload } = context;
  if (phase === "result") {
    applyToolResultPhase(state, toolState, toolCallId, toolName, payload);
    return;
  }

  toolState.status = "running";
}

// ProviderFact 是 SDK 边界；入队前统一在这里把累计态投影成标准 tool.update。
function enqueueToolUpdateFact(
  state: ActiveRunState,
  toolState: ActiveToolState,
  payload: Record<string, unknown>,
): void {
  state.queue.push(buildToolUpdateFact({
    messageId: state.messageId,
    partId: toolState.partId,
    toolCallId: toolState.toolCallId,
    toolName: toolState.toolName,
    status: toolState.status,
    title: toolState.title,
    ...(toolState.input !== undefined ? { input: toolState.input } : {}),
    ...(toolState.output !== undefined ? { output: toolState.output } : {}),
    ...(toolState.error ? { error: toolState.error } : {}),
    raw: payload,
  }));
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
  // OpenClaw 事件可能只携带 sessionKey；这里用 canonical sessionKey 定位正在运行的 SDK run。
  private readonly activeRunsBySessionKey = new Map<string, ActiveRunState>();
  // 部分宿主事件只携带 runId，run 启动后需要反查到 canonical sessionKey。
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

  async createSession(_input: {
    traceId: string;
    title?: string;
    assistantId?: string;
  }): Promise<{ toolSessionId: string }> {
    const toolSessionId = createToolSessionId();
    this.options.sessionRegistry.ensure(toolSessionId);
    return { toolSessionId };
  }

  /**
   * OpenClaw 当前没有可上报的 slash command 列表。
   * @remarks 保持同一查询协议可用，宿主收到空列表后不展示候选命令。
   */
  async listSlashCommands(): Promise<{ slashCommands: [] }> {
    return { slashCommands: [] };
  }

  /**
   * 启动一次 SDK request_run，并立即返回 fact 流与终态 promise。
   * @remarks OpenClaw 的实际执行在后台完成；这里先建立本地输出边界，
   * 这样 abort、宿主晚到事件和错误收口都能落到同一个 `ActiveRunState`。
   */
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
      replyDispatcherOwnsAssistantText: false,
      titleEmitted: false,
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

  /**
   * OpenClaw 当前没有稳定的问题回复宿主接口。
   * @remarks 这里显式 fail-closed，避免 SDK 误以为交互请求已被宿主接收。
   */
  async replyQuestion(_input: ProviderQuestionReplyInput): Promise<{ applied: true }> {
    throw createProviderCommandError("not_supported", "OpenClaw plugin does not support question replies");
  }

  /**
   * 把 SDK permission_reply 映射到 OpenClaw exec approval 决议。
   * @remarks `permissionId` 作为 opaque id 透传给宿主，registry 只负责本地 pending/resolved 状态门禁。
   */
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

    const decision = resolvePermissionDecision(input.reply);
    await this.approvalPort.resolve({
      permissionId: input.permissionId,
      decision,
    });
    this.approvalRegistry.markResolved(input.permissionId);
    return { applied: true };
  }

  /**
   * 关闭会话并清理本地映射。
   * @remarks close_session 是会话生命周期收口；它会删除 subagent 会话，但不再向 SDK 输出 run 终态。
   */
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

  /**
   * 取消当前会话内的活跃 run。
   * @remarks 本地先关闭 fact 流，再 best-effort 调宿主 abort/cancel；
   * 这样即使宿主取消失败，也不会继续向 SDK 投影晚到增量。
   */
  // eslint-disable-next-line complexity -- abort 需要同时协调本地活跃 run、approval 清理和宿主 best-effort cancel。
  async abortSession(input: ProviderAbortSessionInput): Promise<{ applied: true }> {
    const record = this.options.sessionRegistry.get(input.toolSessionId);
    if (!record) {
      throw new Error("unknown_tool_session");
    }

    const activeRun = this.activeRunsBySessionKey.get(record.sessionKey);
    const abortRunId = activeRun?.runId ?? input.runIds[0];
    if (activeRun) {
      this.abortActiveRun(activeRun);
    }
    this.approvalRegistry.clearSession(input.toolSessionId);

    const replyRuntime = (this.options.runtime.channel?.reply ?? {}) as ReplyAbortRuntime;
    let runtimeHandled: boolean;
    try {
      runtimeHandled = await callRuntimeMethod(replyRuntime, ["abortRun", "cancelRun"], {
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
      runtimeHandled = true;
    }
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
      // 新宿主路径优先走 reply runtime；缺路由或缺 dispatcher 能力时退回 subagent 兼容路径。
      const hasRouteResolver = !!this.options.runtime.channel?.routing?.resolveAgentRoute;
      const replyRuntime = asReadyReplyRuntime(this.options.runtime.channel?.reply);
      if (hasRouteResolver && replyRuntime) {
        await this.runWithReplyRuntime(state, input.text, replyRuntime);
      } else {
        await this.runWithSubagentFallback(state, input.text);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.queue.push(buildSessionErrorFact({
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

  private resolveCanonicalSessionKey(
    route: Record<string, unknown>,
    fallback: string,
    options?: { required?: boolean },
  ): string {
    const routed = asTrimmedString(route.sessionKey);
    if (!routed && options?.required) {
      throw new Error("openclaw_route_session_key_unavailable");
    }
    return routed ?? fallback;
  }

  /**
   * 将 SDK 侧临时 sessionKey 切换为 OpenClaw 路由后的 canonical sessionKey。
   * @remarks 之后的 runtime event、abort 和 session record 都必须使用 canonical key，
   * 否则会出现宿主事件找不到 active run 的问题。
   */
  private bindCanonicalSessionKey(state: ActiveRunState, sessionKey: string): void {
    if (sessionKey === state.sessionKey) {
      return;
    }
    this.activeRunsBySessionKey.delete(state.sessionKey);
    state.sessionKey = sessionKey;
    this.options.sessionRegistry.bindSessionKey(state.toolSessionId, sessionKey);
    this.activeRunsBySessionKey.set(sessionKey, state);
  }

  private resolveMessageBridgeRoute(input: {
    cfg: OpenClawConfig;
    state: ActiveRunState;
    required: boolean;
  }): MessageBridgeRoute | null {
    const resolveAgentRoute = this.options.runtime.channel?.routing?.resolveAgentRoute;
    if (!resolveAgentRoute) {
      if (input.required) {
        throw new Error("openclaw_route_resolver_unavailable");
      }
      return null;
    }
    const route = resolveAgentRoute({
      cfg: input.cfg,
      channel: "message-bridge",
      accountId: this.options.account.accountId,
      peer: {
        kind: "direct",
        id: input.state.toolSessionId,
      },
    });
    const raw = asRecord(route) ?? {};
    const sessionKey = asTrimmedString(raw.sessionKey);
    return {
      accountId: asTrimmedString(raw.accountId) ?? this.options.account.accountId,
      agentId: asTrimmedString(raw.agentId) ?? "main",
      ...(sessionKey ? { sessionKey } : {}),
      raw,
    };
  }

  /**
   * 将 OpenClaw 路由结果应用到当前 run。
   * @remarks fallback 路径允许没有 route；reply runtime 路径必须拿到 sessionKey 才能 fail-closed。
   */
  private applyRouteSessionKey(
    state: ActiveRunState,
    route: MessageBridgeRoute | null,
    options?: { required?: boolean },
  ): void {
    if (!route) {
      return;
    }
    this.bindCanonicalSessionKey(
      state,
      this.resolveCanonicalSessionKey(route.raw, state.sessionKey, options),
    );
  }

  // eslint-disable-next-line max-lines-per-function -- reply runtime 执行路径集中维护 OpenClaw block/final/tool 回调顺序。
  private async runWithReplyRuntime(
    state: ActiveRunState,
    text: string,
    replyRuntime: NonNullable<ReturnType<typeof asReadyReplyRuntime>>,
  ): Promise<void> {
    const { createReplyPrefixOptions, normalizeOutboundReplyPayload } = await loadOpenClawPluginSdk();
    const { effectiveConfig, streamingEnabled } = resolveEffectiveReplyConfig(this.options.config);
    state.streamingEnabled = this.options.account.streaming !== false && streamingEnabled;
    const route = this.resolveMessageBridgeRoute({ cfg: effectiveConfig, state, required: true });
    if (!route) {
      throw new Error("openclaw_route_resolver_unavailable");
    }
    this.applyRouteSessionKey(state, route, { required: true });
    // reply dispatcher 已经负责 assistant 文本输出；agent stream 中的 assistant 事件只作为旁路观察。
    state.replyDispatcherOwnsAssistantText = true;
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

    const sessionRuntime = asReadySessionRuntime(this.options.runtime.channel?.session);
    if (sessionRuntime) {
      const sessionConfig = asRecord(effectiveConfig.session);
      const sessionStore = typeof sessionConfig?.store === "string" ? sessionConfig.store : undefined;
      const storePath = sessionRuntime.resolveStorePath(sessionStore, { agentId: route.agentId });
      await sessionRuntime.recordInboundSession({
        storePath,
        sessionKey: state.sessionKey,
        ctx: ctxPayload as Record<string, unknown>,
        createIfMissing: true,
        onRecordError: (error) => {
          this.options.logger.warn("runtime.session_record.failed", {
            toolSessionId: state.toolSessionId,
            sessionKey: state.sessionKey,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
    }

    await replyRuntime.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: effectiveConfig,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (rawPayload: unknown, info: { kind: "tool" | "block" | "final" }) => {
          this.logChatRawEvent({
            source: "runtime_reply_dispatcher",
            eventName: getRuntimeReplyEventName(info.kind),
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
      // dispatcher 的 tool payload 是上一条 tool result 的补充文本，必须挂回对应 tool part。
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
      // final 只暂存，最后统一和 block 累积文本 reconcile，避免重复输出。
      state.pendingFinalText = text;
      return;
    }

    if (!state.streamingEnabled) {
      // 禁用流式时仍累积文本，最终只投影 text.done。
      state.accumulatedText += text;
      return;
    }

    this.ensureMessageStarted(state);
    state.accumulatedText += text;
    state.textDeltaCount += 1;
    state.queue.push(buildTextDeltaFact({
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

    const { effectiveConfig } = resolveEffectiveReplyConfig(this.options.config);
    const route = this.resolveMessageBridgeRoute({ cfg: effectiveConfig, state, required: false });
    this.applyRouteSessionKey(state, route);

    // fallback 只拿最终会话消息，不依赖 reply dispatcher 的 block/final 流式协议。
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
      messageId: state.messageId,
      partId: state.textPartId,
      content: finalText,
    }));
    state.queue.push(buildMessageDoneFact({
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
    // OpenClaw 可能同时给 block 增量和 final 全量；这里集中去重/补尾。
    const reconciliation = reconcileFinalText(state.accumulatedText, state.pendingFinalText);
    const finalText = reconciliation.finalText || state.accumulatedText || "";
    state.accumulatedText = finalText;
    state.queue.push(buildTextDoneFact({
      messageId: state.messageId,
      partId: state.textPartId,
      content: finalText,
      raw: state.pendingFinalText,
    }));
    state.queue.push(buildMessageDoneFact({
      messageId: state.messageId,
    }));
    state.queue.close();
  }

  private ensureMessageStarted(state: ActiveRunState): void {
    if (state.started) {
      return;
    }
    state.started = true;
    if (!state.titleEmitted) {
      // SDK fact 流不携带 toolSessionId，title 只在首条消息开始时补一次。
      state.titleEmitted = true;
      state.queue.push(buildSessionTitleFact({
        toolSessionId: state.toolSessionId,
        title: state.toolSessionId,
      }));
    }
    state.queue.push(buildMessageStartFact({
      messageId: state.messageId,
    }));
  }

  private subscribeRuntimeGatewayEvents(): (() => boolean) | null {
    const events = this.options.runtime.events;
    // 不同 OpenClaw 版本暴露的系统事件订阅名不同，按新到旧兼容探测。
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
    const eventName = getRuntimeGatewayEventName(evt);
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

  /**
   * 把 OpenClaw exec approval 请求投影成 SDK permission.ask fact。
   * @remarks approval 是会话外事件，必须走 outbound 通道，而不是当前 request_run 的 fact 队列。
   */
  private async handleApprovalRequested(eventName: string, payload: Record<string, unknown>): Promise<void> {
    const permissionId = asTrimmedString(payload.id) ?? asTrimmedString(payload.permissionId);
    const toolSessionId = extractToolSessionIdFromRuntimePayload(payload);
    if (!permissionId || !toolSessionId) {
      return;
    }
    const permType = asTrimmedString(payload.type) ?? asTrimmedString(payload.permission);
    if (!permType) {
      this.options.logger.warn("runtime.permission_ask_missing_perm_type", {
        toolSessionId,
        permissionId,
        sourceEvent: eventName,
      });
      return;
    }

    const messageId = asTrimmedString(payload.messageId) ?? `msg_${randomUUID()}`;
    const metadata = pickRecord(payload, "metadata") ?? pickRecord(payload, "meta");
    const title = asTrimmedString(payload.title) ?? "";
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
        buildMessageStartFact({ messageId, raw: payload }),
        buildPermissionAskFact({
          messageId,
          partId: `part_${randomUUID()}`,
          permissionId,
          permType,
          title: record.title,
          metadata: {
            ...(record.metadata ?? {}),
            ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
            status: record.status,
            sourceEvent: eventName,
          },
          raw: payload,
        }),
        buildMessageDoneFact({ messageId }),
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

  /**
   * 发送由宿主事件触发的 outbound fact。
   * @remarks outbound 由 SDK runtime 统一补 session ownership 字段；adapter 不直接写 wire 消息。
   */
  private async emitRuntimeOutboundFacts(input: {
    toolSessionId: string;
    messageId: string;
    trigger: string;
    facts: ProviderFact[] | AsyncIterable<ProviderFact>;
  }): Promise<void> {
    if (!this.outbound) {
      return;
    }
    await this.outbound.emitOutboundMessage({
      toolSessionId: input.toolSessionId,
      messageId: input.messageId,
      trigger: input.trigger,
      facts: Array.isArray(input.facts) ? this.iterateFacts(input.facts) : input.facts,
    });
  }

  private async *iterateFacts(facts: ProviderFact[]): AsyncIterable<ProviderFact> {
    for (const fact of facts) {
      yield fact;
    }
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
      if (state.replyDispatcherOwnsAssistantText) {
        // reply runtime 路径下 assistant 文本由 dispatcher 投影，避免双来源重复增量。
        return;
      }
      this.handleAssistantAgentEvent(state, payload);
      return;
    }
    if (evt.stream === "reasoning") {
      this.handleReasoningAgentEvent(state, payload);
      return;
    }
  }

  // eslint-disable-next-line complexity -- tool 事件需要兼容 OpenClaw 多种字段形态并映射为单一 tool.update fact。
  private handleToolAgentEvent(state: ActiveRunState, payload: Record<string, unknown>): void {
    if (state.abortRequested || state.completed) {
      return;
    }

    this.ensureMessageStarted(state);
    const toolCallId = asTrimmedString(payload.toolCallId) ?? `tool_${randomUUID()}`;
    const toolName = asTrimmedString(payload.name) ?? "tool";
    const phase = asTrimmedString(payload.phase) ?? "update";
    const toolState = getOrCreateToolState(state, toolCallId, toolName);
    toolState.toolName = toolName;
    toolState.title = getToolTitle(payload, toolName);
    mergeToolInput(toolState, payload);
    applyToolPhase({
      state,
      toolState,
      toolCallId,
      toolName,
      phase,
      payload,
    });
    enqueueToolUpdateFact(state, toolState, payload);
  }

  // eslint-disable-next-line complexity -- assistant 事件按 OpenClaw lifecycle 入口集中路由，避免拆散状态机判断。
  private handleAssistantAgentEvent(state: ActiveRunState, payload: Record<string, unknown>): void {
    if (state.abortRequested || state.completed) {
      return;
    }

    const fullText = typeof payload.text === "string" ? payload.text : "";
    let deltaText = typeof payload.delta === "string" ? payload.delta : "";

    // 宿主可能发 full text，也可能发 delta；优先从 full text 里计算未见过的 suffix。
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
      // 非流式模式只更新累积文本，等待最终 text.done。
      return;
    }

    this.ensureMessageStarted(state);
    state.textDeltaCount += 1;
    state.queue.push(buildTextDeltaFact({
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
    const deltaText = getPayloadDeltaText(payload);
    const shouldEmitReasoningDelta =
      deltaText.length > 0 &&
      (phase !== "finish" && phase !== "result" || state.accumulatedThinking.length === 0);
    if (shouldEmitReasoningDelta) {
      // finish/result 可能只带最终 reasoning；若此前没有 delta，也要补一个 delta 保持事实完整。
      state.accumulatedThinking += deltaText;
      this.ensureMessageStarted(state);
      state.queue.push(buildThinkingDeltaFact({
        messageId: state.messageId,
        partId: state.thinkingPartId,
        content: deltaText,
        raw: payload,
      }));
    }

    if (phase === "finish" || phase === "result") {
      this.ensureMessageStarted(state);
      state.queue.push(buildThinkingDoneFact({
        messageId: state.messageId,
        partId: state.thinkingPartId,
        content: state.accumulatedThinking,
        raw: payload,
      }));
    }
  }

  private finalizeRun(state: ActiveRunState): void {
    state.completed = true;
    this.activeRunsBySessionKey.delete(state.sessionKey);
    this.sessionKeyByRunId.delete(state.runId);
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
