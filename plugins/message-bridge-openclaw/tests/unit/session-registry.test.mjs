import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../../src/session/SessionRegistry.ts";

test("ensure creates stable session mapping", () => {
  const registry = new SessionRegistry("bridge:default");
  const first = registry.ensure("tool_1", "wl_1");
  const second = registry.ensure("tool_1");

  assert.equal(first.sessionKey, "bridge:default:tool_1");
  assert.equal(second.sessionKey, first.sessionKey);
  assert.equal(second.welinkSessionId, "wl_1");
});

test("bindSessionKey updates an existing tool session to canonical OpenClaw key", () => {
  const registry = new SessionRegistry("message-bridge:acct");
  const initial = registry.ensure("tool_1", "wl_1");

  assert.equal(initial.sessionKey, "message-bridge:acct:tool_1");

  const rebound = registry.bindSessionKey("tool_1", "agent:main:message-bridge:direct:tool_1");
  const again = registry.ensure("tool_1");

  assert.equal(rebound.sessionKey, "agent:main:message-bridge:direct:tool_1");
  assert.equal(again.sessionKey, "agent:main:message-bridge:direct:tool_1");
  assert.equal(again.welinkSessionId, "wl_1");
});
