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
