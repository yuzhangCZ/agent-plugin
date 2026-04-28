import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

let hooksRegistered = false;

function ensureHooks() {
  if (hooksRegistered) {
    return;
  }
  hooksRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "openclaw/plugin-sdk") {
        return {
          url: "data:text/javascript,",
          shortCircuit: true,
        };
      }
      if (specifier === "openclaw/plugin-sdk/core") {
        return {
          url: "data:text/javascript,export const deleteAccountFromConfigSection = ({ cfg }) => cfg; export const setAccountEnabledInConfigSection = ({ cfg }) => cfg;",
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    },
  });
}

async function loadConfigModule({ cacheKey, defaultGatewayUrl } = {}) {
  ensureHooks();
  if (defaultGatewayUrl === undefined) {
    delete globalThis.__MB_DEFAULT_GATEWAY_URL__;
  } else {
    globalThis.__MB_DEFAULT_GATEWAY_URL__ = defaultGatewayUrl;
  }
  const modulePath = path.resolve("src/config.ts");
  return import(`${pathToFileURL(modulePath).href}?cache=${cacheKey ?? Date.now()}`);
}

function createBaseConfig(overrides = {}) {
  return {
    channels: {
      "message-bridge": {
        enabled: true,
        ...overrides,
      },
    },
  };
}

test("validateMessageBridgeSetupInput preserves existing gateway url when input omits url", async () => {
  const { validateMessageBridgeSetupInput, resolveAccount } = await loadConfigModule({
    cacheKey: "existing-url",
    defaultGatewayUrl: "wss://default.example/ws/agent",
  });
  const cfg = createBaseConfig({
    gateway: {
      url: "wss://configured.example/ws/agent",
    },
    auth: {
      ak: "ak-1",
      sk: "sk-1",
    },
  });

  const error = validateMessageBridgeSetupInput({
    cfg,
    accountId: "default",
    input: {
      token: "ak-2",
      password: "sk-2",
    },
  });

  assert.equal(error, null);
  assert.equal(resolveAccount(cfg, "default").gateway.url, "wss://configured.example/ws/agent");
});

test("resolveAccount prefers injected default gateway url when config omits url", async () => {
  const { validateMessageBridgeSetupInput, resolveAccount } = await loadConfigModule({
    cacheKey: "injected-default",
    defaultGatewayUrl: "wss://default.example/ws/agent",
  });
  const cfg = createBaseConfig({
    auth: {
      ak: "ak-1",
      sk: "sk-1",
    },
  });

  const error = validateMessageBridgeSetupInput({
    cfg,
    accountId: "default",
    input: {
      token: "ak-2",
      password: "sk-2",
    },
  });

  assert.equal(error, null);
  assert.equal(resolveAccount(cfg, "default").gateway.url, "wss://default.example/ws/agent");
});

test("resolveAccount falls back to localhost default gateway url when no injected default exists", async () => {
  const { validateMessageBridgeSetupInput, resolveAccount } = await loadConfigModule({
    cacheKey: "localhost-default",
  });
  const cfg = createBaseConfig({
    auth: {
      ak: "ak-1",
      sk: "sk-1",
    },
  });

  const error = validateMessageBridgeSetupInput({
    cfg,
    accountId: "default",
    input: {
      token: "ak-2",
      password: "sk-2",
    },
  });

  assert.equal(error, null);
  assert.equal(resolveAccount(cfg, "default").gateway.url, "ws://localhost:8081/ws/agent");
});

test("validateMessageBridgeSetupInput rejects invalid explicit gateway url", async () => {
  const { validateMessageBridgeSetupInput } = await loadConfigModule({
    cacheKey: "invalid-url",
    defaultGatewayUrl: "wss://default.example/ws/agent",
  });
  const cfg = createBaseConfig({
    auth: {
      ak: "ak-1",
      sk: "sk-1",
    },
  });

  const error = validateMessageBridgeSetupInput({
    cfg,
    accountId: "default",
    input: {
      url: "https://not-a-websocket.example.com",
      token: "ak-2",
      password: "sk-2",
    },
  });

  assert.match(error, /gateway\.url 必须使用 ws:\/\/ 或 wss:\/\//);
});

test("applyMessageBridgeSetupConfig writes explicit gateway url", async () => {
  const { applyMessageBridgeSetupConfig } = await loadConfigModule({
    cacheKey: "apply-explicit-url",
  });
  const cfg = createBaseConfig({
    auth: {
      ak: "ak-1",
      sk: "sk-1",
    },
  });

  const nextCfg = applyMessageBridgeSetupConfig({
    cfg,
    accountId: "default",
    input: {
      url: "wss://explicit.example/ws/agent",
      token: "ak-2",
      password: "sk-2",
    },
  });

  assert.equal(nextCfg.channels["message-bridge"].gateway.url, "wss://explicit.example/ws/agent");
});

test("applyMessageBridgeSetupConfig preserves existing gateway url when input omits url", async () => {
  const { applyMessageBridgeSetupConfig } = await loadConfigModule({
    cacheKey: "apply-preserve-url",
  });
  const cfg = createBaseConfig({
    gateway: {
      url: "wss://configured.example/ws/agent",
    },
    auth: {
      ak: "ak-1",
      sk: "sk-1",
    },
  });

  const nextCfg = applyMessageBridgeSetupConfig({
    cfg,
    accountId: "default",
    input: {
      token: "ak-2",
      password: "sk-2",
    },
  });

  assert.equal(nextCfg.channels["message-bridge"].gateway.url, "wss://configured.example/ws/agent");
});

test("applyMessageBridgeSetupConfig does not materialize default gateway url when config and input both omit url", async () => {
  const { applyMessageBridgeSetupConfig } = await loadConfigModule({
    cacheKey: "apply-no-materialize-default",
    defaultGatewayUrl: "wss://default.example/ws/agent",
  });
  const cfg = createBaseConfig({
    auth: {
      ak: "ak-1",
      sk: "sk-1",
    },
  });

  const nextCfg = applyMessageBridgeSetupConfig({
    cfg,
    accountId: "default",
    input: {
      token: "ak-2",
      password: "sk-2",
    },
  });

  assert.equal("url" in (nextCfg.channels["message-bridge"].gateway ?? {}), false);
});
