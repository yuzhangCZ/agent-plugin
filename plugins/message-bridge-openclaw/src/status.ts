/* eslint-disable max-lines -- status 模块集中承载 OpenClaw 账户快照、probe 和用户可见诊断。 */
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
import { resolveRegisterMetadata, type RegisterMetadata, warnUnknownToolType } from "./runtime/RegisterMetadata.js";
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
const PROBE_CANCELLED_FOR_RUNTIME_LIFECYCLE = "probe_cancelled_for_runtime_lifecycle";
// 兼容旧版本 runtime start 取消原因；新代码统一使用 runtime lifecycle 取消语义。
const PROBE_CANCELLED_FOR_RUNTIME_START = "probe_cancelled_for_runtime_start";
const IGNORABLE_PROBE_CANCEL_REASONS = new Set([
  PROBE_CANCELLED_FOR_RUNTIME_LIFECYCLE,
  PROBE_CANCELLED_FOR_RUNTIME_START,
]);

const DEFAULT_STREAMING_PATH_ISSUE = {
  message: "当前宿主缺少 route resolver，message-bridge 会退化为非流式回退路径。",
  fix: "升级或校验当前 OpenClaw 宿主，确保 runtime.channel.routing.resolveAgentRoute 与 runtime.channel.reply 都可用。",
};

const STREAMING_PATH_ISSUES: Record<string, { message: string; fix: string }> = {
  missing_reply_runtime: {
    message: "当前宿主缺少 reply runtime，message-bridge 会退化为非流式回退路径。",
    fix: DEFAULT_STREAMING_PATH_ISSUE.fix,
  },
  runtime_reply_final_only: {
    message: "当前宿主虽然提供了 runtime reply，但没有产出可用的增量 block，message-bridge 只能在结束时一次性返回最终文本。",
    fix: "校验当前 OpenClaw 宿主、模型路由和 block streaming 配置，确认 runtime.channel.reply 是否真的会持续产出非空 block。",
  },
  plugin_streaming_disabled_runtime_reply: {
    message: "当前账号显式关闭了 streaming，message-bridge 会使用非流式输出模式。",
    fix: "将 channels.message-bridge.streaming 设为 true，或删除该字段以使用默认开启。",
  },
};

const silentLogger: BridgeLogger = {
  info() {},
  warn() {},
  error() {},
};

function getStreamingPathIssueMessage(reason: string): string {
  return STREAMING_PATH_ISSUES[reason]?.message ?? DEFAULT_STREAMING_PATH_ISSUE.message;
}

function getStreamingPathIssueFix(reason: string): string {
  return STREAMING_PATH_ISSUES[reason]?.fix ?? DEFAULT_STREAMING_PATH_ISSUE.fix;
}

const probeProvider: ThirdPartyAgentProvider = {
  async health() {
    return { online: true };
  },
  async createSession() {
    return { toolSessionId: "probe" };
  },
  async listSlashCommands() {
    return { slashCommands: [] };
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
  toolType: string;
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
  if (runtime?.connected !== true || typeof runtime.lastReadyAt !== "number") {
    return false;
  }
  if (typeof runtime.lastHeartbeatAt !== "number") {
    return true;
  }
  return nowAt - runtime.lastHeartbeatAt <= GATEWAY_CLIENT_DEFAULT_HEARTBEAT_INTERVAL_MS * 2 + HEARTBEAT_GRACE_MS;
}

/**
 * 将 bridge-runtime-sdk 的 probe 返回值转换成 OpenClaw status 层对外暴露的统一结果。
 */
function toProbeResult(probeResult: Awaited<ReturnType<BridgeRuntime["probe"]>>): MessageBridgeProbeResult {
  return {
    ok: probeResult.state === "ready",
    state: probeResult.state,
    latencyMs: probeResult.latencyMs,
    reason: probeResult.reason,
  };
}

/**
 * 构造无需真实连接的新建结果，用于 runtime 已经 ready 的短路路径。
 */
function createReadyProbeResult(startedAt: number, now: () => number, reason: string): MessageBridgeProbeResult {
  return {
    ok: true,
    state: "ready",
    latencyMs: elapsedMs(startedAt, now),
    reason,
  };
}

/**
 * 构造被 runtime 生命周期取消的结果，确保所有取消路径使用同一 reason。
 */
function createCancelledProbeResult(startedAt: number, now: () => number): MessageBridgeProbeResult {
  return {
    ok: false,
    state: "cancelled",
    latencyMs: elapsedMs(startedAt, now),
    reason: PROBE_CANCELLED_FOR_RUNTIME_LIFECYCLE,
  };
}

/**
 * 统一记录 ready 短路日志，避免多个运行态来源产生不同日志形态。
 */
function logReadyProbeShortCircuit(
  logger: BridgeLogger,
  params: {
    accountId: string;
    gatewayUrl: string;
    result: MessageBridgeProbeResult;
  },
): void {
  logger.info("probe.short_circuit.runtime_ready", {
    accountId: params.accountId,
    gatewayUrl: params.gatewayUrl,
    latencyMs: params.result.latencyMs,
    reason: params.result.reason,
  });
}

/**
 * 停止临时 probe runtime，并把清理失败降级为诊断日志。
 * @remarks
 * probe 是状态检查，不应因为清理失败覆盖原本的 probe 结果。
 */
async function stopProbeRuntime(
  probeRuntime: BridgeRuntime,
  logger: BridgeLogger,
  params: {
    accountId: string;
    gatewayUrl: string;
  },
): Promise<void> {
  await probeRuntime.stop().catch((error) => {
    logger.warn("probe.cancel_teardown_failed", {
      accountId: params.accountId,
      gatewayUrl: params.gatewayUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * 尝试用已有运行态回答 probe 请求。
 * @remarks
 * 未命中时必须同步返回 null，不能先 await；否则调用方来不及登记临时 probe 的取消句柄。
 */
function resolveRuntimeProbeShortCircuit(params: {
  activeRuntime?: Pick<BridgeRuntime, "probe">;
  runtime?: MessageBridgeStatusSnapshot;
  resourceKey: string;
  accountId: string;
  gatewayUrl: string;
  timeoutMs: number;
  startedAt: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  logger: BridgeLogger;
}): MessageBridgeProbeResult | Promise<MessageBridgeProbeResult> | null {
  if (params.activeRuntime) {
    return params.activeRuntime.probe({ timeoutMs: params.timeoutMs }).then(toProbeResult);
  }

  const runtimeCoord = getConnectionCoord(params.resourceKey);
  if (runtimeCoord.runtimePhase === "ready") {
    const result = createReadyProbeResult(params.startedAt, params.now, "runtime_coord_ready");
    logReadyProbeShortCircuit(params.logger, { ...params, result });
    return result;
  }

  if (runtimeCoord.runtimePhase === "connecting") {
    return waitForConnectingRuntime(params);
  }

  if (isRuntimeHealthy(params.runtime, params.startedAt)) {
    const result = createReadyProbeResult(params.startedAt, params.now, "runtime_snapshot_healthy");
    logReadyProbeShortCircuit(params.logger, { ...params, result });
    return result;
  }

  return null;
}

/**
 * runtime 正在连接时短暂等待正式连接完成。
 * @remarks
 * 等待时间有上限，避免 status probe 长时间占住调用方；等待后仍未 ready 时返回 connecting。
 */
async function waitForConnectingRuntime(params: {
  resourceKey: string;
  accountId: string;
  gatewayUrl: string;
  timeoutMs: number;
  startedAt: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  logger: BridgeLogger;
}): Promise<MessageBridgeProbeResult> {
  const waitMs = Math.min(params.timeoutMs, PROBE_RUNTIME_WAIT_CAP_MS);
  params.logger.info("probe.wait_runtime.started", {
    accountId: params.accountId,
    gatewayUrl: params.gatewayUrl,
    waitMs,
  });
  await params.sleep(waitMs);
  const afterWaitCoord = getConnectionCoord(params.resourceKey);
  params.logger.info("probe.wait_runtime.completed", {
    accountId: params.accountId,
    gatewayUrl: params.gatewayUrl,
    waitMs,
    runtimePhase: afterWaitCoord.runtimePhase,
  });
  if (afterWaitCoord.runtimePhase === "ready") {
    const result = createReadyProbeResult(params.startedAt, params.now, "runtime_connected_after_wait");
    logReadyProbeShortCircuit(params.logger, { ...params, result });
    return result;
  }

  const result = {
    ok: false,
    state: "connecting",
    latencyMs: elapsedMs(params.startedAt, params.now),
    reason: "runtime_connecting_probe_skipped",
  } satisfies MessageBridgeProbeResult;
  params.logger.warn("probe.short_circuit.runtime_connecting", {
    accountId: params.accountId,
    gatewayUrl: params.gatewayUrl,
    latencyMs: result.latencyMs,
    reason: result.reason,
  });
  return result;
}

/**
 * 在没有可信运行态时创建临时 runtime 做真实连接探测。
 * @remarks
 * 该路径会登记 ConnectionCoordinator，正式 runtime 启动时可以取消临时 probe，避免同账号并发连接互相干扰。
 */
async function probeWithTemporaryRuntime(params: {
  account: MessageBridgeResolvedAccount;
  accountId: string;
  gatewayUrl: string;
  resourceKey: string;
  timeoutMs: number;
  startedAt: number;
  now: () => number;
  logger: BridgeLogger;
  createRuntime: ProbeRuntimeFactory;
  connectionFactory?: ProbeConnectionFactory;
  registerMetadata: RegisterMetadata;
}): Promise<MessageBridgeProbeResult> {
  const { abortController } = beginProbeConnect(params.resourceKey, params.now);
  let probeRuntime: BridgeRuntime | null = null;
  // runtime 正在启动时会取消临时 probe；取消到达后必须停止已创建的临时 runtime，避免并发连接残留。
  const abortProbe = () => {
    if (!probeRuntime) {
      return;
    }
    void stopProbeRuntime(probeRuntime, params.logger, params);
  };

  abortController.signal.addEventListener("abort", abortProbe, { once: true });
  try {
    const runtimeOptions = withOptionalConnectionFactory({
      provider: probeProvider,
      gatewayHost: buildBridgeGatewayHostConfig(params.account, params.registerMetadata),
      logger: params.logger,
      debug: params.account.debug,
    }, params.connectionFactory);
    probeRuntime = await params.createRuntime(runtimeOptions as Parameters<typeof params.createRuntime>[0]);
    if (abortController.signal.aborted) {
      await stopProbeRuntime(probeRuntime, params.logger, params);
      return createCancelledProbeResult(params.startedAt, params.now);
    }

    return toProbeResult(await probeRuntime.probe({ timeoutMs: params.timeoutMs }));
  } finally {
    abortController.signal.removeEventListener("abort", abortProbe);
    finishProbeConnect(params.resourceKey, abortController);
  }
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

/**
 * 探测 message-bridge 账号当前是否可连接。
 * @remarks
 * 优先复用正在运行的 runtime 或协调器快照；只有没有可信运行态时才创建临时 runtime，避免 probe 与正式启动抢同一条连接。
 */
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
  logger.info("probe.requested", {
    accountId,
    gatewayUrl,
    timeoutMs: params.timeoutMs,
    runtimePhase: getConnectionCoord(resourceKey).runtimePhase,
    runtimeConnected: runtime?.connected ?? false,
    lastReadyAt: runtime?.lastReadyAt ?? null,
    lastHeartbeatAt: runtime?.lastHeartbeatAt ?? null,
  });

  // 可信运行态可以直接给出 probe 结果；临时 runtime 只作为最后兜底。
  const shortCircuitResult = resolveRuntimeProbeShortCircuit({
    activeRuntime: params.activeRuntime,
    runtime,
    resourceKey,
    accountId,
    gatewayUrl,
    timeoutMs: params.timeoutMs,
    startedAt,
    now,
    sleep,
    logger,
  });
  if (shortCircuitResult) {
    return await shortCircuitResult;
  }

  const registerMetadata = resolveRegisterMetadata(logger);
  warnUnknownToolType(logger, registerMetadata.toolType, accountId);
  return await probeWithTemporaryRuntime({
    account: params.account,
    accountId,
    gatewayUrl,
    resourceKey,
    timeoutMs: params.timeoutMs,
    startedAt,
    now,
    logger,
    createRuntime,
    connectionFactory: deps.connectionFactory,
    registerMetadata,
  });
}

// eslint-disable-next-line complexity -- status snapshot 需要兼容 OpenClaw channel account 的多种运行时输入形态。
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
    connected: runtime?.connected ?? false,
    gatewayUrl: account.gateway.url || null,
    toolType: registerMetadata.toolType,
    toolVersion: registerMetadata.toolVersion,
    runTimeoutMs: account.runTimeoutMs,
    tokenSource: resolveTokenSource(account),
    legacyAccountsConfigured,
    missingConfigFields,
    routeResolverAvailable: runtime?.routeResolverAvailable ?? false,
    replyRuntimeAvailable: runtime?.replyRuntimeAvailable ?? false,
    streamingPathHealthy: runtime?.streamingPathHealthy ?? false,
    streamingPathReason: runtime?.streamingPathReason ?? null,
    lastInboundAt: runtime?.lastInboundAt ?? null,
    lastOutboundAt: runtime?.lastOutboundAt ?? null,
    lastReadyAt: runtime?.lastReadyAt ?? null,
    lastHeartbeatAt: runtime?.lastHeartbeatAt ?? null,
    lastProbeAt: runtime?.lastProbeAt ?? null,
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

// eslint-disable-next-line max-lines-per-function, max-statements, complexity -- 状态问题汇总集中维护用户可见诊断和修复建议。
export function collectMessageBridgeStatusIssues(
  accounts: ChannelAccountSnapshot[],
  now: () => number = Date.now,
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  const nowAt = now();

  for (const rawSnapshot of accounts) {
    const snapshot = asMessageBridgeSnapshot(rawSnapshot);
    const probe = asRecord(snapshot.probe);
    const probeReason = getProbeReason(probe);
    const suppressDuplicateConnectionIssue =
      probe?.state === "rejected" &&
      probeReason === "duplicate_connection" &&
      isRuntimeHealthyForDuplicateConnection(snapshot, nowAt);
    const missingConfigFields = getMissingConfigFields(snapshot);
    const runTimeoutMs = typeof snapshot.runTimeoutMs === "number" ? snapshot.runTimeoutMs : 0;
    if (snapshot.legacyAccountsConfigured) {
      issues.push(
        createConfigIssue({
          accountId: snapshot.accountId,
          message: `检测到已废弃的 channels.message-bridge.accounts 配置。`,
          fix: LEGACY_ACCOUNTS_MIGRATION_FIX,
        }),
      );
    }

    if (missingConfigFields.length > 0) {
      issues.push(
        createConfigIssue({
          accountId: snapshot.accountId,
          message: `缺少必填配置：${missingConfigFields.join("、")}`,
          fix: CHANNEL_ADD_FIX,
        }),
      );
    }

    if ((snapshot.streamingPathHealthy ?? false) === false) {
      const reason = typeof snapshot.streamingPathReason === "string" ? snapshot.streamingPathReason : "missing_route_resolver";
      issues.push(
        createRuntimeIssue({
          accountId: snapshot.accountId,
          message: getStreamingPathIssueMessage(reason),
          fix: getStreamingPathIssueFix(reason),
        }),
      );
    }

    if (probe && typeof probe.error === "string" && probe.error.trim()) {
      issues.push(
        createRuntimeIssue({
          accountId: snapshot.accountId,
          message: `探活执行失败：${probe.error.trim()}`,
          fix: "检查 gateway.url、运行环境中的 WebSocket 支持与 ai-gateway 进程状态。",
        }),
      );
    }

    if (probe?.state === "rejected" && !suppressDuplicateConnectionIssue) {
      const rawReason = probeReason;
      const reason = rawReason ? `：${rawReason}` : "";
      if (rawReason && isAuthRejectedReason(rawReason)) {
        issues.push(
          createAuthIssue({
            accountId: snapshot.accountId,
            message: `网关鉴权被拒绝${reason}`,
            fix: "检查 channels.message-bridge.auth.ak / auth.sk 是否与 ai-gateway 侧配置一致。",
          }),
        );
      } else {
        issues.push(
          createRuntimeIssue({
            accountId: snapshot.accountId,
            message: `网关拒绝注册${reason}`,
            fix: "检查 ai-gateway 的注册策略、toolType/toolVersion 与协议兼容性。",
          }),
        );
      }
    }

    if (probe?.state === "connecting") {
      continue;
    }

    if (probe?.state === "cancelled" && IGNORABLE_PROBE_CANCEL_REASONS.has(probeReason)) {
      continue;
    }

    if (probe?.state === "connect_error") {
      const reason =
        typeof probe.reason === "string" && probe.reason.trim()
          ? `：${probe.reason.trim()}`
          : "";
      issues.push(
        createRuntimeIssue({
          accountId: snapshot.accountId,
          message: `探活无法连接 ai-gateway${reason}`,
          fix: "检查 gateway.url、网络连通性和 ai-gateway 进程状态。",
        }),
      );
    }

    if (probe?.state === "timeout") {
      issues.push(
        createRuntimeIssue({
          accountId: snapshot.accountId,
          message: "探活在进入 READY 前超时。",
          fix: "检查 ai-gateway 当前负载、鉴权链路与网络时延。",
        }),
      );
    }

    if (typeof snapshot.lastError === "string" && snapshot.lastError.trim()) {
      issues.push(
        createRuntimeIssue({
          accountId: snapshot.accountId,
          message: `最近一次运行错误：${snapshot.lastError.trim()}`,
          fix: "结合 ai-gateway 日志与 bridge.chat.failed 诊断链路问题。",
        }),
      );
    }

    if (snapshot.running !== true) {
      continue;
    }

    const heartbeatThresholdMs = getHeartbeatThresholdMs();
    if (
      typeof snapshot.lastHeartbeatAt === "number" &&
      nowAt - snapshot.lastHeartbeatAt > heartbeatThresholdMs
    ) {
      issues.push(
        createRuntimeIssue({
          accountId: snapshot.accountId,
          message: "心跳超过阈值未更新，可能已与 ai-gateway 断连。",
          fix: "检查 gateway 连接状态，必要时重启 channel。",
        }),
      );
    }

    const latestActivityAt = Math.max(snapshot.lastInboundAt ?? 0, snapshot.lastOutboundAt ?? 0);
    const activityThresholdMs = Math.max(
      runTimeoutMs,
      GATEWAY_CLIENT_DEFAULT_HEARTBEAT_INTERVAL_MS * 3,
    );
    if (activityThresholdMs > 0 && latestActivityAt > 0 && nowAt - latestActivityAt > activityThresholdMs) {
      issues.push(
        createRuntimeIssue({
          accountId: snapshot.accountId,
          message: "最近收发活动超过阈值未更新，bridge 可能已卡住。",
          fix: "检查 ai-gateway 链路与 runTimeoutMs 配置，必要时重启 channel。",
        }),
      );
    }
  }

  return issues;
}
