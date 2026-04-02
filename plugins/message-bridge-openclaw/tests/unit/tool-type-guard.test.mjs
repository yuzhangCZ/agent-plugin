import assert from "node:assert/strict";
import test from "node:test";
import { KNOWN_TOOL_TYPES, isKnownToolType } from "../../src/contracts/transport.ts";
import { MESSAGE_BRIDGE_TOOL_TYPE, warnUnknownToolType } from "../../src/runtime/RegisterMetadata.ts";

test("known tool types only include openx", () => {
  assert.deepEqual(KNOWN_TOOL_TYPES, ["openx"]);
  assert.equal(isKnownToolType("openx"), true);
  assert.equal(isKnownToolType("codeagent"), false);
});

test("register metadata default toolType is openx", () => {
  assert.equal(MESSAGE_BRIDGE_TOOL_TYPE, "openx");
});

test("warnUnknownToolType emits warning for unknown value and stays non-blocking", () => {
  const warns = [];
  const logger = {
    info() {},
    warn(message, meta) {
      warns.push({ message, meta });
    },
    error() {},
  };

  warnUnknownToolType(logger, "legacy-tool-type", "default");
  const warnLog = warns.find((entry) => entry.message === "runtime.register.tool_type.unknown");
  assert.ok(warnLog);
  assert.equal(warnLog.meta.toolType, "legacy-tool-type");
  assert.deepEqual(warnLog.meta.knownToolTypes, ["openx"]);
  assert.equal(warnLog.meta.accountId, "default");
});

test("warnUnknownToolType does nothing for known value", () => {
  const warns = [];
  const logger = {
    info() {},
    warn(message, meta) {
      warns.push({ message, meta });
    },
    error() {},
  };

  warnUnknownToolType(logger, "openx", "default");
  assert.equal(warns.length, 0);
});
