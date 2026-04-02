import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ConfigResolver } from "../../src/config/ConfigResolver.ts";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_DEFAULT_GATEWAY_URL = globalThis.__MB_DEFAULT_GATEWAY_URL__;

function restoreInjectedDefaultGatewayUrl() {
  if (typeof ORIGINAL_DEFAULT_GATEWAY_URL === "undefined") {
    delete globalThis.__MB_DEFAULT_GATEWAY_URL__;
    return;
  }

  globalThis.__MB_DEFAULT_GATEWAY_URL__ = ORIGINAL_DEFAULT_GATEWAY_URL;
}

async function importDefaultGatewayModule(cacheKey) {
  const moduleUrl = `${pathToFileURL(resolve("src/config/default-gateway-url.ts")).href}?cache=${cacheKey}`;
  return import(moduleUrl);
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  restoreInjectedDefaultGatewayUrl();
});

test("falls back to localhost when build default gateway url is not injected", async () => {
  delete globalThis.__MB_DEFAULT_GATEWAY_URL__;
  const mod = await importDefaultGatewayModule("fallback");
  assert.equal(mod.DEFAULT_GATEWAY_URL, "ws://localhost:8081/ws/agent");
});

test("uses injected build default gateway url when available", async () => {
  globalThis.__MB_DEFAULT_GATEWAY_URL__ = "wss://gateway.example.com/ws/agent";
  const mod = await importDefaultGatewayModule("injected");
  assert.equal(mod.DEFAULT_GATEWAY_URL, "wss://gateway.example.com/ws/agent");
});

test("keeps runtime BRIDGE_GATEWAY_URL override higher priority than build default", async () => {
  process.env.BRIDGE_GATEWAY_URL = "wss://runtime.example.com/ws/agent";
  const tempHome = await mkdtemp(join(tmpdir(), "message-bridge-config-"));
  process.env.HOME = tempHome;

  try {
    const config = await new ConfigResolver().resolveConfig(tempHome);
    assert.equal(config.gateway.url, "wss://runtime.example.com/ws/agent");
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});
