/* eslint-disable max-lines -- OpenClaw 状态模块仍聚合 runtime/probe/snapshot 对外契约，后续按子模块拆分。 */
import {
  buildBaseAccountStatusSnapshot,
  buildProbeChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  type ChannelAccountSnapshot,
  type ChannelStatusIssue,
} from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  createBridgeRuntime,
  type BridgeRuntime,
  type ThirdPartyAgentProvider,
} from "@wecode/bridge-runtime-sdk";
import {
  CHANNEL_ADD_FIX,
  DEFAULT_ACCOUNT_ID,
  LEGACY_ACCOUNTS_MIGRATION_FIX,
  getMissingRequiredConfigPaths,
  hasLegacyAccountsConfig,
  resolveTokenSource,
} from "./config.js";
import type {
  BridgeLogger,
  MessageBridgeProbeResult,
  MessageBridgeResolvedAccount,
  MessageBridgeStatusSnapshot,
} from "./types.js";
import { resolveRegisterMetadata, type RegisterMetadata, warnUnknownChannel } from "./runtime/RegisterMetadata.js";
import {
  type BridgeRuntimeConnectionFactory,
  withOptionalConnectionFactory,
} from "./runtime/bridgeRuntimeConnectionFactory.js";
import { beginProbeConnect, finishProbeConnect, getConnectionCoord } from "./runtime/ConnectionCoordinator.js";
import { asRecord } from "./utils/type-guards.js";
import { buildBridgeGatewayHostConfig, buildMessageBridgeResourceKey } from "./gateway-host.js";

const HEARTBEAT_GRACE_MS = 5_000;
const GATEWAY_CLIENT_DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const PROBE_RUNTIME_WAIT_CAP_MS = 1_000;

const silentLogger: BridgeLogger = {
  info() {},
  warn() {},
  error() {},
};

const probeProvider: ThirdPartyAgentProvider = {
  async health() {
    return { online: true };
  },
  async createSession() {
    return { toolSessionId: "probe" };
  },
  async runMessage() {
    return {
      runId: "probe",
      facts: (async function* () {})(),
      async result() {
        return { outcome: "completed" as const };
      },
    };
  },
  async replyQuestion() {
    return { applied: true };
  },
  async replyPermission() {
    return { applied: true };
  },
  async closeSession() {
    return { applied: true };
  },
  async abortSession() {
    return { applied: true };
  },
};

type ProbeConnectionFactory = BridgeRuntimeConnectionFactory;

type ProbeRuntimeFactory = typeof createBridgeRuntime;

type MessageBridgeRuntimeSnapshotLike = Pick<
  MessageBridgeStatusSnapshot,
  | "connected"
  | "routeResolverAvailable"
  | "replyRuntimeAvailable"
  | "streamingPathHealthy"
  | "streamingPathReason"
  | "lastInboundAt"
  | "lastOutboundAt"
  | "lastReadyAt"
  | "lastHeartbeatAt"
  | "lastProbeAt"
>;

export type MessageBridgeAccountSnapshot = ChannelAccountSnapshot & {
  connected: boolean;
  gatewayUrl: string | null;
  channel: string;
  toolVersion: string;
  runTimeoutMs: number;
  tokenSource: "config" | "none";
  legacyAccountsConfigured: boolean;
  missingConfigFields: string[];
  routeResolverAvailable?: boolean;
  replyRuntimeAvailable?: boolean;
  streamingPathHealthy?: boolean;
  streamingPathReason?: string | null;
  lastReadyAt: number | null;
  lastHeartbeatAt: number | null;
};

function elapsedMs(startedAt: number, now: () => number): number {
  return Math.max(0, now() - startedAt);
}

function asMessageBridgeSnapshot(value: ChannelAccountSnapshot): MessageBridgeAccountSnapshot {
  return value as MessageBridgeAccountSnapshot;
}

function getMissingConfigFields(snapshot: MessageBridgeAccountSnapshot): string[] {
  return Array.isArray(snapshot.missingConfigFields) ? snapshot.missingConfigFields : [];
}

function isAuthRejectedReason(reason: string): boolean {
  return /(ak|sk|auth|credential|forbidden|secret|signature|token|unauthor|未授权|鉴权|凭证|密钥|签名)/i.test(
    reason,
  );
}

function getProbeReason(probe: Record<string, unknown> | null): string {
  if (!probe || typeof probe.reason !== "string") {
    return "";
  }
  return probe.reason.trim();
}

function getHeartbeatThresholdMs(): number {
  return GATEWAY_CLIENT_DEFAULT_HEARTBEAT_INTERVAL_MS * 2 + HEARTBEAT_GRACE_MS;
}

function withDefault<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

function isRuntimeHealthyForDuplicateConnection(
  snapshot: MessageBridgeAccountSnapshot,
  nowAt: number,
): boolean {
  if (snapshot.connected !== true || typeof snapshot.lastReadyAt !== "number") {
    return false;
  }

  if (typeof snapshot.lastHeartbeatAt !== "number") {
    return true;
  }

  const heartbeatThresholdMs = getHeartbeatThresholdMs();
  if (heartbeatThresholdMs <= 0) {
    return true;
  }

  return nowAt - snapshot.lastHeartbeatAt <= heartbeatThresholdMs;
}

function isRuntimeHealthy(
  runtime: MessageBridgeStatusSnapshot | undefined,
  nowAt: number,
): boolean {
  if (!runtime || runtime.connected !== true || typeof runtime.lastReadyAt !== "number") {
    return false;
  }
  if (typeof runtime.lastHeartbeatAt !== "number") {
    return true;
  }
  return nowAt - runtime.lastHeartbeatAt <= GATEWAY_CLIENT_DEFAULT_HEARTBEAT_INTERVAL_MS * 2 + HEARTBEAT_GRACE_MS;
}

export function createDefaultMessageBridgeRuntimeState(): MessageBridgeStatusSnapshot {
  return createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
    connected: false,
    runtimePhase: "idle" as const,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    routeResolverAvailable: false,
    replyRuntimeAvailable: false,
    streamingPathHealthy: false,
    streamingPathReason: "missing_route_resolver" as const,
    lastReadyAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastHeartbeatAt: null,
    probe: null,
    lastProbeAt: null,
  });
}

// eslint-disable-next-line complexity, max-lines-per-function, max-statements -- 探活流程需要在单个函数内串联 active runtime、连接协调、临时 runtime 与取消清理。
export async function probeMessageBridgeAccount(
  params: {
    account: MessageBridgeResolvedAccount;
    timeoutMs: number;
    runtime?: MessageBridgeStatusSnapshot | ChannelAccountSnapshot;
    activeRuntime?: Pick<BridgeRuntime, "probe">;
    logger?: BridgeLogger;
  },
  deps: {
    connectionFactory?: ProbeConnectionFactory;
    createRuntime?: ProbeRuntimeFactory;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<MessageBridgeProbeResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const logger = params.logger ?? silentLogger;
  const createRuntime = deps.createRuntime ?? createBridgeRuntime;
  const runtime = params.runtime as MessageBridgeStatusSnapshot | undefined;
  const accountId = params.account.accountId;
  const gatewayUrl = params.account.gateway.url;
  const resourceKey = buildMessageBridgeResourceKey(params.account);
  const runtimeCoord = getConnectionCoord(resourceKey);
  logger.info("probe.requested", {
    accountId,
    gatewayUrl,
    timeoutMs: params.timeoutMs,
    runtimePhase: runtimeCoord.runtimePhase,
    runtimeConnected: runtime?.connected ?? false,
    lastReadyAt: runtime?.lastReadyAt ?? null,
    lastHeartbeatAt: runtime?.lastHeartbeatAt ?? null,
  });

  if (params.activeRuntime) {
    const probeResult = await params.activeRuntime.probe({ timeoutMs: params.timeoutMs });
    return {
      ok: probeResult.state === "ready",
      state: probeResult.state,
      latencyMs: probeResult.latencyMs,
      reason: probeResult.reason,
    };
  }

  if (runtimeCoord.runtimePhase === "ready") {
    const result = {
      ok: true,
      state: "ready",
      latencyMs: elapsedMs(startedAt, now),
      reason: "runtime_coord_ready",
    } satisfies MessageBridgeProbeResult;
    logger.info("probe.short_circuit.runtime_ready", {
      accountId,
      gatewayUrl,
      latencyMs: result.latencyMs,
      reason: result.reason,
    });
    return result;
  }

  if (runtimeCoord.runtimePhase === "connecting") {
    const waitMs = Math.min(params.timeoutMs, PROBE_RUNTIME_WAIT_CAP_MS);
    logger.info("probe.wait_runtime.started", {
      accountId,
      gatewayUrl,
      waitMs,
    });
    await sleep(waitMs);
    const afterWaitCoord = getConnectionCoord(resourceKey);
    logger.info("probe.wait_runtime.completed", {
      accountId,
      gatewayUrl,
      waitMs,
      runtimePhase: afterWaitCoord.runtimePhase,
    });
    if (afterWaitCoord.runtimePhase === "ready") {
      const result = {
        ok: true,
        state: "ready",
        latencyMs: elapsedMs(startedAt, now),
        reason: "runtime_connected_after_wait",
      } satisfies MessageBridgeProbeResult;
      logger.info("probe.short_circuit.runtime_ready", {
        accountId,
        gatewayUrl,
        latencyMs: result.latencyMs,
        reason: result.reason,
      });
      return result;
    }

    const result = {
      ok: false,
      state: "connecting",
      latencyMs: elapsedMs(startedAt, now),
      reason: "runtime_connecting_probe_skipped",
    } satisfies MessageBridgeProbeResult;
    logger.warn("probe.short_circuit.runtime_connecting", {
      accountId,
      gatewayUrl,
      latencyMs: result.latencyMs,
      reason: result.reason,
    });
    return result;
  }

  if (isRuntimeHealthy(runtime, startedAt)) {
    const result = {
      ok: true,
      state: "ready",
      latencyMs: elapsedMs(startedAt, now),
      reason: "runtime_snapshot_healthy",
    } satisfies MessageBridgeProbeResult;
    logger.info("probe.short_circuit.runtime_ready", {
      accountId,
      gatewayUrl,
      latencyMs: result.latencyMs,
      reason: result.reason,
    });
    return result;
  }

  const registerMetadata = resolveRegisterMetadata(logger);
  warnUnknownChannel(logger, registerMetadata.channel, accountId);
  const { abortController } = beginProbeConnect(resourceKey, now);
  let probeRuntime: BridgeRuntime | null = null;
  const buildCancelledResult = (): MessageBridgeProbeResult => ({
    ok: false,
    state: "cancelled",
    latencyMs: elapsedMs(startedAt, now),
    reason: "probe_cancelled_for_runtime_start",
  });
  const abortProbe = () => {
    if (!probeRuntime) {
      return;
    }
    void probeRuntime.stop().catch((error) => {
      logger.warn("probe.cancel_teardown_failed", {
        accountId,
        gatewayUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  abortController.signal.addEventListener("abort", abortProbe, { once: true });
  try {
    const runtimeOptions = withOptionalConnectionFactory({
      provider: probeProvider,
      gatewayHost: buildBridgeGatewayHostConfig(params.account, registerMetadata),
      logger,
      debug: params.account.debug,
    }, deps.connectionFactory);
    probeRuntime = await createRuntime(runtimeOptions as Parameters<typeof createRuntime>[0]);
    if (abortController.signal.aborted) {
      await probeRuntime.stop().catch((error) => {
        logger.warn("probe.cancel_teardown_failed", {
          accountId,
          gatewayUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return buildCancelledResult();
    }

    const probeResult = await probeRuntime.probe({ timeoutMs: params.timeoutMs });
    return {
      ok: probeResult.state === "ready",
      state: probeResult.state,
      latencyMs: probeResult.latencyMs,
      reason: probeResult.reason,
    };
  } finally {
    abortController.signal.removeEventListener("abort", abortProbe);
    finishProbeConnect(resourceKey, abortController);
  }
}

export function buildMessageBridgeAccountSnapshot(params: {
  account: MessageBridgeResolvedAccount;
  cfg: OpenClawConfig;
  runtime?: MessageBridgeStatusSnapshot | ChannelAccountSnapshot | Partial<MessageBridgeRuntimeSnapshotLike>;
  probe?: unknown;
  registerMetadata?: RegisterMetadata;
}): MessageBridgeAccountSnapshot {
  const { account, cfg, probe } = params;
  const runtime = params.runtime as MessageBridgeStatusSnapshot | undefined;
  const registerMetadata = params.registerMetadata ?? resolveRegisterMetadata(silentLogger);
  const missingConfigFields = getMissingRequiredConfigPaths(account, cfg);
  const legacyAccountsConfigured = hasLegacyAccountsConfig(cfg);
  const configured = missingConfigFields.length === 0 && !legacyAccountsConfigured;
  const runtimeFields = buildRuntimeSnapshotFields(runtime);

  return {
    ...buildBaseAccountStatusSnapshot({
      account: {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
      },
      runtime,
      probe,
    }),
    connected: runtimeFields.connected,
    gatewayUrl: account.gateway.url || null,
    channel: registerMetadata.channel,
    toolVersion: registerMetadata.toolVersion,
    runTimeoutMs: account.runTimeoutMs,
    tokenSource: resolveTokenSource(account),
    legacyAccountsConfigured,
    missingConfigFields,
    ...runtimeFields,
  };
}

function buildRuntimeSnapshotFields(runtime: MessageBridgeStatusSnapshot | undefined): MessageBridgeRuntimeSnapshotLike {
  return {
    connected: withDefault(runtime?.connected, false),
    routeResolverAvailable: withDefault(runtime?.routeResolverAvailable, false),
    replyRuntimeAvailable: withDefault(runtime?.replyRuntimeAvailable, false),
    streamingPathHealthy: withDefault(runtime?.streamingPathHealthy, false),
    streamingPathReason: withDefault(runtime?.streamingPathReason, null),
    lastInboundAt: withDefault(runtime?.lastInboundAt, null),
    lastOutboundAt: withDefault(runtime?.lastOutboundAt, null),
    lastReadyAt: withDefault(runtime?.lastReadyAt, null),
    lastHeartbeatAt: withDefault(runtime?.lastHeartbeatAt, null),
    lastProbeAt: withDefault(runtime?.lastProbeAt, null),
  };
}

export function buildMessageBridgeChannelSummary(snapshot: ChannelAccountSnapshot): Record<string, unknown> {
  const bridgeSnapshot = asMessageBridgeSnapshot(snapshot);
  return {
    ...buildProbeChannelStatusSummary(snapshot, {
      connected: bridgeSnapshot.connected ?? false,
      lastReadyAt: bridgeSnapshot.lastReadyAt ?? null,
      lastHeartbeatAt: bridgeSnapshot.lastHeartbeatAt ?? null,
    }),
    streaming: {
      routeResolverAvailable: bridgeSnapshot.routeResolverAvailable ?? false,
      replyRuntimeAvailable: bridgeSnapshot.replyRuntimeAvailable ?? false,
      pathHealthy: bridgeSnapshot.streamingPathHealthy ?? false,
      reason: bridgeSnapshot.streamingPathReason ?? null,
    },
  };
}

function createConfigIssue(params: {
  accountId: string;
  message: string;
  fix: string;
}): ChannelStatusIssue {
  return {
    channel: "message-bridge",
    accountId: params.accountId,
    kind: "config",
    message: params.message,
    fix: params.fix,
  };
}

function createRuntimeIssue(params: {
  accountId: string;
  message: string;
  fix: string;
}): ChannelStatusIssue {
  return {
    channel: "message-bridge",
    accountId: params.accountId,
    kind: "runtime",
    message: params.message,
    fix: params.fix,
  };
}

function createAuthIssue(params: {
  accountId: string;
  message: string;
  fix: string;
}): ChannelStatusIssue {
  return {
    channel: "message-bridge",
    accountId: params.accountId,
    kind: "auth",
    message: params.message,
    fix: params.fix,
  };
}

export function collectMessageBridgeStatusIssues(
  accounts: ChannelAccountSnapshot[],
  now: () => number = Date.now,
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  const nowAt = now();

  for (const rawSnapshot of accounts) {
    const snapshot = asMessageBridgeSnapshot(rawSnapshot);
    issues.push(...collectSnapshotPreflightIssues(snapshot));
    const probeIssues = collectProbeIssues(snapshot, nowAt);
    issues.push(...probeIssues.issues);
    if (probeIssues.skipRuntimeHealthIssues) {
      continue;
    }
    issues.push(...collectRuntimeHealthIssues(snapshot, nowAt));
  }

  return issues;
}

function collectSnapshotPreflightIssues(snapshot: MessageBridgeAccountSnapshot): ChannelStatusIssue[] {
  return [
    ...collectConfigIssues(snapshot),
    ...collectStreamingIssues(snapshot),
  ];
}

function collectConfigIssues(snapshot: MessageBridgeAccountSnapshot): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  if (snapshot.legacyAccountsConfigured) {
    issues.push(createConfigIssue({
      accountId: snapshot.accountId,
      message: `检测到已废弃的 channels.message-bridge.accounts 配置。`,
      fix: LEGACY_ACCOUNTS_MIGRATION_FIX,
    }));
  }
  const missingConfigFields = getMissingConfigFields(snapshot);
  if (missingConfigFields.length > 0) {
    issues.push(createConfigIssue({
      accountId: snapshot.accountId,
      message: `缺少必填配置：${missingConfigFields.join("、")}`,
      fix: CHANNEL_ADD_FIX,
    }));
  }
  return issues;
}

function collectStreamingIssues(snapshot: MessageBridgeAccountSnapshot): ChannelStatusIssue[] {
  if (snapshot.streamingPathHealthy === true) {
    return [];
  }
  const reason = typeof snapshot.streamingPathReason === "string"
    ? snapshot.streamingPathReason
    : "missing_route_resolver";
  return [
    createRuntimeIssue({
      accountId: snapshot.accountId,
      message: getStreamingIssueMessage(reason),
      fix: getStreamingIssueFix(reason),
    }),
  ];
}

function getStreamingIssueMessage(reason: string): string {
  switch (reason) {
    case "missing_reply_runtime":
      return "当前宿主缺少 reply runtime，message-bridge 会退化为非流式回退路径。";
    case "runtime_reply_final_only":
      return "当前宿主虽然提供了 runtime reply，但没有产出可用的增量 block，message-bridge 只能在结束时一次性返回最终文本。";
    case "plugin_streaming_disabled_runtime_reply":
      return "当前账号显式关闭了 streaming，message-bridge 会使用非流式输出模式。";
    default:
      return "当前宿主缺少 route resolver，message-bridge 会退化为非流式回退路径。";
  }
}

function getStreamingIssueFix(reason: string): string {
  switch (reason) {
    case "plugin_streaming_disabled_runtime_reply":
      return "将 channels.message-bridge.streaming 设为 true，或删除该字段以使用默认开启。";
    case "runtime_reply_final_only":
      return "校验当前 OpenClaw 宿主、模型路由和 block streaming 配置，确认 runtime.channel.reply 是否真的会持续产出非空 block。";
    default:
      return "升级或校验当前 OpenClaw 宿主，确保 runtime.channel.routing.resolveAgentRoute 与 runtime.channel.reply 都可用。";
  }
}

function collectProbeIssues(
  snapshot: MessageBridgeAccountSnapshot,
  nowAt: number,
): {
  issues: ChannelStatusIssue[];
  skipRuntimeHealthIssues: boolean;
} {
  const probe = asRecord(snapshot.probe);
  const probeReason = getProbeReason(probe);
  const issues = probe ? buildProbeIssues(snapshot, probe, probeReason, nowAt) : [];
  return {
    issues,
    skipRuntimeHealthIssues: shouldSkipRuntimeHealthIssues(probe, probeReason),
  };
}

function buildProbeIssues(
  snapshot: MessageBridgeAccountSnapshot,
  probe: Record<string, unknown>,
  probeReason: string,
  nowAt: number,
): ChannelStatusIssue[] {
  return [
    ...collectProbeExecutionErrorIssues(snapshot, probe),
    ...collectProbeRejectedIssues(snapshot, probe, probeReason, nowAt),
    ...collectProbeConnectionIssues(snapshot, probe),
  ];
}

function collectProbeExecutionErrorIssues(
  snapshot: MessageBridgeAccountSnapshot,
  probe: Record<string, unknown>,
): ChannelStatusIssue[] {
  if (typeof probe.error !== "string" || !probe.error.trim()) {
    return [];
  }
  return [
    createRuntimeIssue({
      accountId: snapshot.accountId,
      message: `探活执行失败：${probe.error.trim()}`,
      fix: "检查 gateway.url、运行环境中的 WebSocket 支持与 ai-gateway 进程状态。",
    }),
  ];
}

function collectProbeRejectedIssues(
  snapshot: MessageBridgeAccountSnapshot,
  probe: Record<string, unknown>,
  probeReason: string,
  nowAt: number,
): ChannelStatusIssue[] {
  if (probe.state !== "rejected" || shouldSuppressDuplicateConnectionIssue(snapshot, probeReason, nowAt)) {
    return [];
  }
  const reason = probeReason ? `：${probeReason}` : "";
  const issueFactory = probeReason && isAuthRejectedReason(probeReason) ? createAuthIssue : createRuntimeIssue;
  return [
    issueFactory({
      accountId: snapshot.accountId,
      message: probeReason && isAuthRejectedReason(probeReason)
        ? `网关鉴权被拒绝${reason}`
        : `网关拒绝注册${reason}`,
      fix: probeReason && isAuthRejectedReason(probeReason)
        ? "检查 channels.message-bridge.auth.ak / auth.sk 是否与 ai-gateway 侧配置一致。"
        : "检查 ai-gateway 的注册策略、channel/toolVersion 与协议兼容性。",
    }),
  ];
}

function shouldSuppressDuplicateConnectionIssue(
  snapshot: MessageBridgeAccountSnapshot,
  probeReason: string,
  nowAt: number,
): boolean {
  return probeReason === "duplicate_connection" && isRuntimeHealthyForDuplicateConnection(snapshot, nowAt);
}

function collectProbeConnectionIssues(
  snapshot: MessageBridgeAccountSnapshot,
  probe: Record<string, unknown>,
): ChannelStatusIssue[] {
  if (probe.state === "connect_error") {
    return [createRuntimeIssue({
      accountId: snapshot.accountId,
      message: `探活无法连接 ai-gateway${formatReasonSuffix(probe.reason)}`,
      fix: "检查 gateway.url、网络连通性和 ai-gateway 进程状态。",
    })];
  }
  if (probe.state === "timeout") {
    return [createRuntimeIssue({
      accountId: snapshot.accountId,
      message: "探活在进入 READY 前超时。",
      fix: "检查 ai-gateway 当前负载、鉴权链路与网络时延。",
    })];
  }
  return [];
}

function formatReasonSuffix(reason: unknown): string {
  return typeof reason === "string" && reason.trim() ? `：${reason.trim()}` : "";
}

function shouldSkipRuntimeHealthIssues(probe: Record<string, unknown> | null, probeReason: string): boolean {
  return probe?.state === "connecting" ||
    (probe?.state === "cancelled" && probeReason === "probe_cancelled_for_runtime_start");
}

function collectRuntimeHealthIssues(
  snapshot: MessageBridgeAccountSnapshot,
  nowAt: number,
): ChannelStatusIssue[] {
  const lastErrorIssue = collectLastRuntimeErrorIssue(snapshot);
  if (snapshot.running !== true) {
    return lastErrorIssue;
  }
  return [
    ...lastErrorIssue,
    ...collectHeartbeatIssue(snapshot, nowAt),
    ...collectActivityIssue(snapshot, nowAt),
  ];
}

function collectLastRuntimeErrorIssue(snapshot: MessageBridgeAccountSnapshot): ChannelStatusIssue[] {
  if (typeof snapshot.lastError !== "string" || !snapshot.lastError.trim()) {
    return [];
  }
  return [createRuntimeIssue({
    accountId: snapshot.accountId,
    message: `最近一次运行错误：${snapshot.lastError.trim()}`,
    fix: "结合 ai-gateway 日志与 bridge.chat.failed 诊断链路问题。",
  })];
}

function collectHeartbeatIssue(snapshot: MessageBridgeAccountSnapshot, nowAt: number): ChannelStatusIssue[] {
  if (
    typeof snapshot.lastHeartbeatAt !== "number" ||
    nowAt - snapshot.lastHeartbeatAt <= getHeartbeatThresholdMs()
  ) {
    return [];
  }
  return [createRuntimeIssue({
    accountId: snapshot.accountId,
    message: "心跳超过阈值未更新，可能已与 ai-gateway 断连。",
    fix: "检查 gateway 连接状态，必要时重启 channel。",
  })];
}

function collectActivityIssue(snapshot: MessageBridgeAccountSnapshot, nowAt: number): ChannelStatusIssue[] {
  const latestActivityAt = Math.max(withDefault(snapshot.lastInboundAt, 0), withDefault(snapshot.lastOutboundAt, 0));
  const runTimeoutMs = typeof snapshot.runTimeoutMs === "number" ? snapshot.runTimeoutMs : 0;
  const activityThresholdMs = Math.max(runTimeoutMs, GATEWAY_CLIENT_DEFAULT_HEARTBEAT_INTERVAL_MS * 3);
  if (activityThresholdMs <= 0 || latestActivityAt <= 0 || nowAt - latestActivityAt <= activityThresholdMs) {
    return [];
  }
  return [createRuntimeIssue({
    accountId: snapshot.accountId,
    message: "最近收发活动超过阈值未更新，bridge 可能已卡住。",
    fix: "检查 ai-gateway 链路与 runTimeoutMs 配置，必要时重启 channel。",
  })];
}
