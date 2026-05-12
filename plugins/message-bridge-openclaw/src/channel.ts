import {
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import {
  resolveAccount,
} from "./config.js";
import {
  messageBridgeCapabilities,
  messageBridgeConfigAdapter,
  messageBridgeConfigSchema,
  messageBridgeMeta,
  messageBridgeSetupAdapter,
} from "./channel.shared.js";
import { OpenClawGatewayBridge } from "./OpenClawGatewayBridge.js";
import { messageBridgeOnboardingAdapter } from "./onboarding.js";
import { messageBridgeSetupWizard } from "./setup-wizard.js";
import {
  cancelProbeForRuntimeStart,
  getAccountLogger,
  getRuntimeSnapshot,
  markRuntimePhase,
  resetRuntimeCoord,
  setAccountLogger,
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

const activeBridges = new Map<string, OpenClawGatewayBridge>();

export const messageBridgePlugin: ChannelPlugin<MessageBridgeResolvedAccount> = {
  id: messageBridgeMeta.id,
  meta: messageBridgeMeta,
  capabilities: messageBridgeCapabilities,
  onboarding: messageBridgeOnboardingAdapter,
  setupWizard: messageBridgeSetupWizard,
  reload: {
    configPrefixes: [`channels.${messageBridgeMeta.id}`],
  },
  configSchema: messageBridgeConfigSchema,
  config: messageBridgeConfigAdapter,
  setup: messageBridgeSetupAdapter,
  status: {
    defaultRuntime: createDefaultMessageBridgeRuntimeState(),
    buildChannelSummary: ({ snapshot }) => buildMessageBridgeChannelSummary(snapshot),
    probeAccount: async ({ account, timeoutMs }) =>
      await probeMessageBridgeAccount({
        account,
        timeoutMs,
        runtime: getRuntimeSnapshot(account.accountId),
        logger: getAccountLogger(account.accountId) ?? console,
      }),
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
      setAccountLogger(account.accountId, logger);
      markRuntimePhase(account.accountId, "connecting");
      cancelProbeForRuntimeStart(account.accountId);
      const bridge = new OpenClawGatewayBridge({
        account,
        config: ctx.cfg,
        runtime: getPluginRuntime(),
        logger,
        setStatus: (status) => ctx.setStatus(status),
      });
      activeBridges.set(account.accountId, bridge);
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
        activeBridges.delete(account.accountId);
        try {
          await bridge.stop();
        } finally {
          resetRuntimeCoord(account.accountId);
          setAccountLogger(account.accountId, null);
        }
      }
    },
    stopAccount: async (ctx) => {
      const account = resolveAccount(ctx.cfg, ctx.accountId);
      const bridge = activeBridges.get(account.accountId);
      if (!bridge) {
        return;
      }
      activeBridges.delete(account.accountId);
      await bridge.stop();
    },
  },
};
