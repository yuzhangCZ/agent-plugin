declare module "openclaw/plugin-sdk" {
  export interface OpenClawConfig {
    channels?: Record<string, unknown>;
    agents?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface ChannelRouteResolver {
    resolveAgentRoute?(input: unknown): { accountId: string; agentId: string; sessionKey?: string };
  }

  export interface ReplyRuntimeLike {
    resolveEnvelopeFormatOptions?(config: unknown): unknown;
    formatAgentEnvelope?(input: unknown): unknown;
    finalizeInboundContext?(input: unknown): unknown;
    dispatchReplyWithBufferedBlockDispatcher?(input: unknown): Promise<void>;
    abortRun?(params: { sessionKey: string; runId?: string }): Promise<void>;
    cancelRun?(params: { sessionKey: string; runId?: string }): Promise<void>;
  }

  export interface SessionRuntimeLike {
    resolveStorePath?(store: string | undefined, opts: { agentId: string }): string;
    recordInboundSession?(input: {
      storePath: string;
      sessionKey: string;
      ctx: Record<string, unknown>;
      createIfMissing?: boolean;
      onRecordError: (err: unknown) => void;
    }): Promise<void>;
    readSessionUpdatedAt?(params: { storePath: string; sessionKey: string }): number | undefined;
  }

  export interface PluginRuntime {
    channel?: {
      routing?: ChannelRouteResolver;
      reply?: ReplyRuntimeLike;
      session?: SessionRuntimeLike;
    };
    events?: {
      onAgentEvent?(listener: (evt: unknown) => void): () => boolean;
      onGatewayEvent?(listener: (evt: unknown) => void): () => boolean;
      onSystemEvent?(listener: (evt: unknown) => void): () => boolean;
      onEvent?(listener: (evt: unknown) => void): () => boolean;
    };
    request?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    gatewayClient?: { request?: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
    gateway?: { request?: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
    question?: { reply?: (params: { requestId: string; answer: string }) => Promise<void> };
    questions?: { reply?: (params: { requestId: string; answer: string }) => Promise<void> };
    subagent?: {
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
  }

  export interface OpenClawPluginApi {
    runtime: PluginRuntime;
    registerChannel(input: { plugin: unknown }): void;
  }

  export interface ChannelConfigSchema {
    schema: Record<string, unknown>;
    uiHints?: Record<string, unknown>;
  }

  export interface ChannelSetupInput {
    name?: string;
    password?: string;
    token?: string;
    url?: string;
    useEnv?: boolean;
  }

  export interface ChannelAccountSnapshot {
    accountId: string;
    name?: string;
    enabled?: boolean;
    configured?: boolean;
    connected?: boolean;
    gatewayUrl?: string | null;
    toolType?: string;
    toolVersion?: string;
    runTimeoutMs?: number;
    tokenSource?: string;
    legacyAccountsConfigured?: boolean;
    missingConfigFields?: string[];
    routeResolverAvailable?: boolean;
    replyRuntimeAvailable?: boolean;
    streamingPathHealthy?: boolean;
    streamingPathReason?: string | null;
    lastReadyAt?: number | null;
    lastHeartbeatAt?: number | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
    lastProbeAt?: number | null;
    runtimePhase?: string;
    probe?: unknown;
    [key: string]: unknown;
  }

  export interface ChannelStatusIssue {
    channel: string;
    accountId: string;
    kind: "config" | "runtime" | "auth";
    message: string;
    fix: string;
  }

  export interface ChannelPrompter {
    note(message: string, title?: string): Promise<void>;
    text(input: {
      message: string;
      placeholder?: string;
      initialValue?: string;
    }): Promise<string>;
  }

  export interface ChannelOnboardingAdapter {
    channel: string;
    getStatus(args: { cfg: OpenClawConfig }): Promise<unknown>;
    configure(args: { cfg: OpenClawConfig; prompter: ChannelPrompter }): Promise<unknown>;
    configureInteractive?(args: { cfg: OpenClawConfig; prompter: ChannelPrompter }): Promise<unknown>;
  }

  export interface ChannelSetupWizard {
    channel: string;
    status?: {
      configuredLabel?: string;
      unconfiguredLabel?: string;
      resolveConfigured?: (input: { cfg: OpenClawConfig }) => boolean;
      resolveStatusLines?: (input: { cfg: OpenClawConfig; configured: boolean }) => string[];
      resolveSelectionHint?: (input: { cfg: OpenClawConfig; configured: boolean }) => string;
      resolveQuickstartScore?: (input: { cfg: OpenClawConfig; configured: boolean }) => number;
    };
    introNote?: {
      title?: string;
      lines?: string[];
    };
    stepOrder?: string;
    credentials?: unknown[];
    textInputs?: Array<{
      inputKey: string;
      message: string;
      placeholder?: string;
      required?: boolean;
      applyEmptyValue?: boolean;
      currentValue?: (input: { cfg: OpenClawConfig }) => string | undefined;
      keepPrompt?: ((value: string) => string) | string;
      applySet?: (input: { cfg: OpenClawConfig; value: string }) => OpenClawConfig;
      validate?: (input: { value: string }) => string | undefined;
    }>;
    prepare?: (args: { cfg: OpenClawConfig }) => unknown;
    finalize?: (args: { cfg: OpenClawConfig }) => unknown;
  }

  export interface ChannelPluginConfig<TAccount = unknown> {
    listAccountIds?(cfg: OpenClawConfig): string[];
    resolveAccount?(cfg: OpenClawConfig, accountId?: string | null): TAccount;
    defaultAccountId?(): string;
    setAccountEnabled?(input: { cfg: OpenClawConfig; accountId: string; enabled: boolean }): OpenClawConfig;
    deleteAccount?(input: { cfg: OpenClawConfig; accountId: string }): OpenClawConfig;
    isEnabled?(account: TAccount): boolean;
    disabledReason?(account: TAccount, cfg: OpenClawConfig): string;
    isConfigured?(account: TAccount, cfg: OpenClawConfig): boolean;
    unconfiguredReason?(account: TAccount, cfg: OpenClawConfig): string;
    describeAccount?(account: TAccount, cfg: OpenClawConfig): unknown;
  }

  export interface ChannelPluginSetup {
    resolveAccountId?(input: { accountId?: string | null }): string;
    applyAccountName?(input: { cfg: OpenClawConfig; accountId: string; name: string }): OpenClawConfig;
    validateInput?(input: { cfg: OpenClawConfig; accountId: string; input: ChannelSetupInput }): string | null;
    applyAccountConfig?(input: { cfg: OpenClawConfig; accountId: string; input: ChannelSetupInput }): OpenClawConfig;
  }

  export interface ChannelPluginStatus<TAccount = unknown> {
    defaultRuntime?: unknown;
    buildChannelSummary?(input: { snapshot: ChannelAccountSnapshot }): Record<string, unknown>;
    probeAccount?(input: { account: TAccount; timeoutMs: number }): Promise<unknown>;
    buildAccountSnapshot?(input: {
      account: TAccount;
      cfg: OpenClawConfig;
      runtime?: ChannelAccountSnapshot | {
        connected?: boolean;
        routeResolverAvailable?: boolean;
        replyRuntimeAvailable?: boolean;
        streamingPathHealthy?: boolean;
        streamingPathReason?: string | null;
        lastInboundAt?: number | null;
        lastOutboundAt?: number | null;
        lastReadyAt?: number | null;
        lastHeartbeatAt?: number | null;
        lastProbeAt?: number | null;
      };
      probe?: unknown;
    }): ChannelAccountSnapshot;
    collectStatusIssues?(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[];
  }

  export interface ChannelPluginGateway<TAccount = unknown> {
    startAccount?(ctx: {
      cfg: OpenClawConfig;
      accountId: string;
      log?: Console;
      abortSignal: AbortSignal;
      setStatus: (status: unknown) => void;
    }): Promise<void>;
    stopAccount?(ctx: { cfg: OpenClawConfig; accountId: string }): Promise<void>;
  }

  export interface ChannelPlugin<TAccount = unknown> {
    id: string;
    meta: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
    onboarding?: ChannelOnboardingAdapter;
    setupWizard?: ChannelSetupWizard;
    reload?: Record<string, unknown>;
    configSchema?: ChannelConfigSchema;
    config?: ChannelPluginConfig<TAccount>;
    setup?: ChannelPluginSetup;
    status?: ChannelPluginStatus<TAccount>;
    gateway?: ChannelPluginGateway<TAccount>;
  }
}

declare module "openclaw/plugin-sdk/core" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk";

  export function definePluginEntry<T>(entry: T): T;
  export function emptyPluginConfigSchema(): Record<string, unknown>;
  export function applyAccountNameToChannelSection(input: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId: string;
    name: string;
  }): OpenClawConfig;
  export function setAccountEnabledInConfigSection(input: {
    cfg: OpenClawConfig;
    channelKey?: string;
    sectionKey?: string;
    accountId: string;
    enabled: boolean;
    allowTopLevel?: boolean;
  }): OpenClawConfig;
}

declare module "openclaw/plugin-sdk/status-helpers" {
  import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk";

  export function buildBaseAccountStatusSnapshot(input: {
    account: {
      accountId: string;
      name?: string;
      enabled: boolean;
      configured: boolean;
    };
    runtime?: unknown;
    probe?: unknown;
  }): Pick<ChannelAccountSnapshot, "accountId" | "name" | "enabled" | "configured" | "probe">;

  export function buildProbeChannelStatusSummary(
    snapshot: ChannelAccountSnapshot,
    input: {
      connected: boolean;
      lastReadyAt: number | null;
      lastHeartbeatAt: number | null;
    },
  ): Record<string, unknown>;

  export function createDefaultChannelRuntimeState<T extends Record<string, unknown>>(
    accountId: string,
    state: T,
  ): T & { accountId: string; running: boolean };
}

declare module "openclaw/plugin-sdk/channel-runtime" {
  export function createReplyPrefixOptions(input: unknown): Record<string, unknown>;
}

declare module "openclaw/plugin-sdk/reply-payload" {
  export function normalizeOutboundReplyPayload(input: unknown): Record<string, unknown>;
}
