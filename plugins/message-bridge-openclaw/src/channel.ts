import {
  type ChannelConfigSchema,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { applyAccountNameToChannelSection } from "openclaw/plugin-sdk/core";
import {
  applyMessageBridgeSetupConfig,
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  deleteMessageBridgeAccount,
  describeAccount,
  isAccountConfigured,
  listAccountIds,
  resolveAccount,
  resolveSupportedAccountId,
  resolveUnconfiguredReason,
  setMessageBridgeAccountEnabled,
  validateMessageBridgeSetupInput,
} from "./config.js";
import { OpenClawGatewayBridge } from "./OpenClawGatewayBridge.js";
import { messageBridgeOnboardingAdapter } from "./onboarding.js";
import {
  cancelProbeForRuntimeStart,
  getAccountLogger,
  getRuntimeSnapshot,
  markRuntimePhase,
  resetRuntimeCoord,
  setAccountLogger,
  waitForProbeSettlement,
} from "./runtime/ConnectionCoordinator.js";
import { getPluginRuntime } from "./runtime/store.js";
import type { MessageBridgeResolvedAccount } from "./types.js";
import {
  buildMessageBridgeAccountSnapshot,
  buildMessageBridgeChannelSummary,
  collectMessageBridgeStatusIssues,
  createDefaultMessageBridgeRuntimeState,
  probeMessageBridgeAccount,
} from "./status.js";
import { buildMessageBridgeResourceKey } from "./gateway-host.js";

const activeBridges = new Map<string, OpenClawGatewayBridge>();
const activeBridgeResourcesByAccount = new Map<string, string>();

const messageBridgeConfigSchema: ChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      debug: { type: "boolean" },
      streaming: { type: "boolean" },
      name: { type: "string", minLength: 1 },
      gateway: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", minLength: 1 },
        },
        required: ["url"],
      },
      auth: {
        type: "object",
        additionalProperties: false,
        properties: {
          ak: { type: "string", minLength: 1 },
          sk: { type: "string", minLength: 1 },
        },
        required: ["ak", "sk"],
      },
      agentIdPrefix: { type: "string", minLength: 1 },
      runTimeoutMs: { type: "integer", minimum: 1_000 },
    },
    required: ["gateway", "auth"],
  },
  uiHints: {
    "auth.ak": {
      label: "AK",
      sensitive: true,
    },
    "auth.sk": {
      label: "SK",
      sensitive: true,
    },
  },
};

export const messageBridgePlugin: ChannelPlugin<MessageBridgeResolvedAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Message Bridge",
    selectionLabel: "Message Bridge",
    docsPath: "/channels/message-bridge",
    blurb: "Bridge ai-gateway sessions into OpenClaw.",
  },
  capabilities: {
    chatTypes: ["direct"],
    nativeCommands: false,
    blockStreaming: true,
  },
  onboarding: messageBridgeOnboardingAdapter,
  reload: {
    configPrefixes: [`channels.${CHANNEL_ID}`],
  },
  configSchema: messageBridgeConfigSchema,
  config: {
    listAccountIds: (cfg: OpenClawConfig) => listAccountIds(cfg),
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => resolveAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setMessageBridgeAccountEnabled({
        cfg,
        accountId,
        enabled,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteMessageBridgeAccount({
        cfg,
        accountId,
      }),
    isEnabled: (account) => account.enabled,
    disabledReason: () => "disabled",
    isConfigured: (account, cfg) => isAccountConfigured(account, cfg),
    unconfiguredReason: (_account, cfg) => resolveUnconfiguredReason(cfg),
    describeAccount: (account, cfg) => describeAccount(account, cfg),
  },
  setup: {
    resolveAccountId: ({ accountId }) => resolveSupportedAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: CHANNEL_ID,
        accountId,
        name,
      }),
    validateInput: ({ cfg, accountId, input }) =>
      validateMessageBridgeSetupInput({
        cfg,
        accountId,
        input,
      }),
    applyAccountConfig: ({ cfg, accountId, input }) =>
      applyMessageBridgeSetupConfig({
        cfg,
        accountId,
        input,
      }),
  },
  status: {
    defaultRuntime: createDefaultMessageBridgeRuntimeState(),
    buildChannelSummary: ({ snapshot }) => buildMessageBridgeChannelSummary(snapshot),
    probeAccount: async ({ account, timeoutMs }) => {
      const resourceKey = buildMessageBridgeResourceKey(account);
      return await probeMessageBridgeAccount({
        account,
        timeoutMs,
        runtime: getRuntimeSnapshot(resourceKey),
        activeRuntime: activeBridges.get(resourceKey),
        logger: getAccountLogger(account.accountId) ?? console,
      });
    },
    buildAccountSnapshot: ({ account, cfg, runtime, probe }) =>
      buildMessageBridgeAccountSnapshot({
        account,
        cfg,
        runtime,
        probe,
      }),
    collectStatusIssues: (accounts) => collectMessageBridgeStatusIssues(accounts),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = resolveAccount(ctx.cfg, ctx.accountId);
      const logger = ctx.log ?? console;
      const resourceKey = buildMessageBridgeResourceKey(account);
      setAccountLogger(account.accountId, logger);
      markRuntimePhase(resourceKey, "connecting");
      if (cancelProbeForRuntimeStart(resourceKey)) {
        await waitForProbeSettlement(resourceKey);
      }
      const bridge = new OpenClawGatewayBridge({
        account,
        config: ctx.cfg,
        runtime: getPluginRuntime(),
        logger,
        setStatus: (status) => ctx.setStatus(status),
      });
      activeBridges.set(resourceKey, bridge);
      activeBridgeResourcesByAccount.set(account.accountId, resourceKey);
      try {
        await bridge.start();
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal.aborted) {
            resolve();
            return;
          }
          ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        activeBridges.delete(resourceKey);
        if (activeBridgeResourcesByAccount.get(account.accountId) === resourceKey) {
          activeBridgeResourcesByAccount.delete(account.accountId);
        }
        try {
          await bridge.stop();
        } finally {
          resetRuntimeCoord(resourceKey);
          setAccountLogger(account.accountId, null);
        }
      }
    },
    stopAccount: async (ctx) => {
      const account = resolveAccount(ctx.cfg, ctx.accountId);
      const resourceKey = activeBridgeResourcesByAccount.get(account.accountId) ?? buildMessageBridgeResourceKey(account);
      const bridge = activeBridges.get(resourceKey);
      if (!bridge) {
        return;
      }
      activeBridges.delete(resourceKey);
      activeBridgeResourcesByAccount.delete(account.accountId);
      await bridge.stop();
    },
  },
};
