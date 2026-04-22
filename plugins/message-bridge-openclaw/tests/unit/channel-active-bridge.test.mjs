import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

let channelModulePromise = null;
let storeModulePromise = null;

async function loadChannelModules() {
  if (!channelModulePromise) {
    globalThis.__messageBridgeTestBridgeInstances = [];
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "openclaw/plugin-sdk") {
          return {
            url: "data:text/javascript,export const emptyPluginConfigSchema = () => ({});",
            shortCircuit: true,
          };
        }
        if (specifier === "openclaw/plugin-sdk/core") {
          return {
            url: "data:text/javascript,export const applyAccountNameToChannelSection = () => {}; export const deleteAccountFromConfigSection = () => {}; export const setAccountEnabledInConfigSection = () => {};",
            shortCircuit: true,
          };
        }
        if (specifier === "openclaw/plugin-sdk/status-helpers") {
          return {
            url: "data:text/javascript,export const buildBaseAccountStatusSnapshot = (input) => ({ ...input.account, ...input.runtime, probe: input.probe ?? null }); export const buildProbeChannelStatusSummary = () => ({}); export const createDefaultChannelRuntimeState = (accountId, state) => ({ accountId, running: false, ...state });",
            shortCircuit: true,
          };
        }
        if (specifier === "./OpenClawGatewayBridge.js" && context.parentURL?.endsWith("/src/channel.ts")) {
          return {
            url: "data:text/javascript,export class OpenClawGatewayBridge { constructor(options) { this.options = options; this.stopCalls = 0; globalThis.__messageBridgeTestBridgeInstances.push(this); } async start() {} async stop() { this.stopCalls += 1; } async probe() { return { state: 'ready', latencyMs: 0, reason: 'test' }; } }",
            shortCircuit: true,
          };
        }
        return nextResolve(specifier, context);
      },
    });
    channelModulePromise = import("../../src/channel.ts");
    storeModulePromise = import("../../src/runtime/store.ts");
  }
  return {
    channel: await channelModulePromise,
    store: await storeModulePromise,
  };
}

function createConfig(url, ak) {
  return {
    channels: {
      "message-bridge": {
        gateway: {
          url,
        },
        auth: {
          ak,
          sk: "sk",
        },
      },
    },
  };
}

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("stopAccount stops the active bridge even when current config resource key changed", async () => {
  const { channel, store } = await loadChannelModules();
  store.setPluginRuntime({});
  const abortController = new AbortController();
  const statuses = [];
  const startPromise = channel.messageBridgePlugin.gateway.startAccount({
    cfg: createConfig("ws://old.example/ws", "old-ak"),
    accountId: "default",
    log: logger,
    setStatus(status) {
      statuses.push(status);
    },
    abortSignal: abortController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const [bridge] = globalThis.__messageBridgeTestBridgeInstances;
  assert.ok(bridge);

  await channel.messageBridgePlugin.gateway.stopAccount({
    cfg: createConfig("ws://new.example/ws", "new-ak"),
    accountId: "default",
  });

  assert.equal(bridge.stopCalls, 1);

  abortController.abort();
  await startPromise;
});
