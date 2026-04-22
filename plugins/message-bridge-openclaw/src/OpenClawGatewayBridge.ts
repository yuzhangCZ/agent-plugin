import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import {
  createBridgeRuntime,
  type BridgeGatewayHostConfig,
  type BridgeGatewayHostConnection,
  type BridgeRuntime,
} from "@agent-plugin/bridge-runtime-sdk";

import type { BridgeLogger, MessageBridgeResolvedAccount, MessageBridgeStatusSnapshot } from "./types.js";
import { resolveRegisterMetadata, type RegisterMetadata, warnUnknownToolType } from "./runtime/RegisterMetadata.js";
import { markRuntimePhase, updateRuntimeSnapshot } from "./runtime/ConnectionCoordinator.js";
import { SessionRegistry } from "./session/SessionRegistry.js";
import { buildBridgeGatewayHostConfig, buildMessageBridgeResourceKey } from "./gateway-host.js";
import { OpenClawProviderAdapter } from "./sdk/OpenClawProviderAdapter.js";

export interface OpenClawGatewayBridgeOptions {
  account: MessageBridgeResolvedAccount;
  config: OpenClawConfig;
  logger: BridgeLogger;
  runtime: PluginRuntime;
  setStatus: (status: MessageBridgeStatusSnapshot) => void;
  registerMetadata?: RegisterMetadata;
  connectionFactory?: (gatewayHost: BridgeGatewayHostConfig) => BridgeGatewayHostConnection;
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

export class OpenClawGatewayBridge {
  private readonly bridgeRuntime: Promise<BridgeRuntime>;
  private bridgeRuntimeFacade: BridgeRuntime | null = null;
  private readonly runtime: PluginRuntime;
  private readonly resourceKey: string;
  private statusSyncTimer: ReturnType<typeof setInterval> | null = null;
  private lastLoggedGatewayState: string | null = null;
  private pendingStatusRefresh = false;
  private runtimePhaseOverride: MessageBridgeStatusSnapshot["runtimePhase"] | null = null;
  private running = false;
  private status: MessageBridgeStatusSnapshot;

  constructor(private readonly options: OpenClawGatewayBridgeOptions) {
    this.runtime = options.runtime;
    const registerMetadata = options.registerMetadata ?? resolveRegisterMetadata(options.logger);
    this.resourceKey = buildMessageBridgeResourceKey(options.account);
    warnUnknownToolType(options.logger, registerMetadata.toolType, options.account.accountId);

    const sessionRegistry = new SessionRegistry(`${options.account.agentIdPrefix}:${options.account.accountId}`);
    this.bridgeRuntime = createBridgeRuntime({
      provider: new OpenClawProviderAdapter({
        account: this.options.account,
        config: this.options.config,
        logger: this.options.logger,
        runtime: this.runtime,
        sessionRegistry,
        getSubagentRuntime: () => this.getSubagentRuntime(),
        isOnline: () => this.running && this.bridgeRuntimeFacade?.getStatus().state === "ready",
      }),
      gatewayHost: buildBridgeGatewayHostConfig(options.account, registerMetadata),
      logger: options.logger,
      debug: options.account.debug,
      connectionFactory: options.connectionFactory,
      onTelemetryUpdated: () => {
        this.requestImmediateStatusRefresh();
      },
    }).then((runtime) => {
      this.bridgeRuntimeFacade = runtime;
      return runtime;
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
  }

  private syncStatusFromBridgeRuntime(): void {
    if (!this.bridgeRuntimeFacade) {
      return;
    }

    const runtimeStatus = this.bridgeRuntimeFacade.getStatus();
    const diagnostics = this.bridgeRuntimeFacade.getDiagnostics();
    const nextRuntimePhase =
      this.runtimePhaseOverride ??
      (runtimeStatus.state === "ready"
        ? "ready"
        : runtimeStatus.state === "starting" || runtimeStatus.state === "reconnecting"
          ? "connecting"
          : runtimeStatus.state === "stopping"
            ? "stopping"
            : runtimeStatus.state === "failed"
              ? "failed"
              : "idle");

    if (diagnostics.gatewayState && diagnostics.gatewayState !== this.lastLoggedGatewayState) {
      this.lastLoggedGatewayState = diagnostics.gatewayState;
      this.options.logger.info("gateway.state.changed", { state: diagnostics.gatewayState });
    }

    if (this.status.runtimePhase !== nextRuntimePhase) {
      markRuntimePhase(this.resourceKey, nextRuntimePhase);
      if (nextRuntimePhase === "ready") {
        this.status.lastReadyAt = diagnostics.lastReadyAt;
      }
    }

    this.status.connected = nextRuntimePhase === "ready";
    this.status.runtimePhase = nextRuntimePhase;
    this.status.lastError = runtimeStatus.failureReason;
    this.status.lastReadyAt = diagnostics.lastReadyAt;
    this.status.lastInboundAt = diagnostics.lastInboundAt;
    this.status.lastOutboundAt = diagnostics.lastOutboundAt;
    this.status.lastHeartbeatAt = diagnostics.lastHeartbeatAt;
  }

  private requestImmediateStatusRefresh(): void {
    if (this.pendingStatusRefresh) {
      return;
    }
    this.pendingStatusRefresh = true;
    queueMicrotask(() => {
      this.pendingStatusRefresh = false;
      this.publishStatus();
    });
  }

  private publishStatus(): void {
    this.syncStatusFromBridgeRuntime();
    updateRuntimeSnapshot(this.resourceKey, { ...this.status });
    this.options.setStatus({ ...this.status });
  }

  private startStatusSyncLoop(): void {
    if (this.statusSyncTimer) {
      return;
    }
    this.statusSyncTimer = setInterval(() => {
      this.publishStatus();
    }, 250);
    this.statusSyncTimer.unref?.();
  }

  private stopStatusSyncLoop(): void {
    if (!this.statusSyncTimer) {
      return;
    }
    clearInterval(this.statusSyncTimer);
    this.statusSyncTimer = null;
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
    this.runtimePhaseOverride = null;
    this.status.running = true;
    this.status.runtimePhase = "connecting";
    this.status.lastStartAt = Date.now();
    markRuntimePhase(this.resourceKey, "connecting");
    this.publishStatus();
    try {
      const runtime = await this.bridgeRuntime;
      await runtime.start();
      this.startStatusSyncLoop();
      this.publishStatus();
    } catch (error) {
      this.stopStatusSyncLoop();
      this.running = false;
      this.status.running = false;
      this.status.runtimePhase = "failed";
      this.status.lastError = error instanceof Error ? error.message : String(error);
      this.status.connected = false;
      markRuntimePhase(this.resourceKey, "failed");
      this.publishStatus();
      throw error;
    }
    this.options.logger.info("runtime.start.completed", {
      accountId: this.options.account.accountId,
    });
  }

  async probe(input: { timeoutMs: number }) {
    const runtime = await this.bridgeRuntime;
    return runtime.probe(input);
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
    this.runtimePhaseOverride = "stopping";
    this.status.runtimePhase = "stopping";
    markRuntimePhase(this.resourceKey, "stopping");
    this.publishStatus();
    const runtime = await this.bridgeRuntime;
    await runtime.stop();
    this.runtimePhaseOverride = null;
    this.stopStatusSyncLoop();
    this.status.running = false;
    this.status.connected = false;
    this.status.runtimePhase = "idle";
    this.status.lastStopAt = Date.now();
    markRuntimePhase(this.resourceKey, "idle");
    this.publishStatus();
    this.options.logger.info("runtime.stop.completed", {
      accountId: this.options.account.accountId,
    });
  }

  private getSubagentRuntime(): SubagentRuntime["subagent"] | null {
    return (this.runtime as Partial<SubagentRuntime>).subagent ?? null;
  }
}
