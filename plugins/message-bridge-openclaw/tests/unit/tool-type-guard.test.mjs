import assert from "node:assert/strict";
import test from "node:test";
import { KNOWN_TOOL_TYPES, isKnownToolType } from "../../src/contracts/transport.ts";
import { MESSAGE_BRIDGE_TOOL_TYPE, resolveRegisterMetadata, warnUnknownToolType } from "../../src/runtime/RegisterMetadata.ts";

test("known tool types only include openclaw", () => {
  assert.deepEqual(KNOWN_TOOL_TYPES, ["openclaw"]);
  assert.equal(isKnownToolType("openclaw"), true);
  assert.equal(isKnownToolType("codeagent"), false);
});

test("register metadata default toolType is openclaw", () => {
  assert.equal(MESSAGE_BRIDGE_TOOL_TYPE, "openclaw");
});

test("register metadata only carries plugin-owned fields", () => {
  const metadata = resolveRegisterMetadata(
    {
      info() {},
      warn() {},
      error() {},
    },
    { toolVersion: "1.2.3" },
  );

  assert.deepEqual(metadata, {
    toolType: "openclaw",
    toolVersion: "1.2.3",
    pluginVersion: "unknown",
  });
  assert.equal("deviceName" in metadata, false);
  assert.equal("macAddress" in metadata, false);
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
  assert.deepEqual(warnLog.meta.knownToolTypes, ["openclaw"]);
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

  warnUnknownToolType(logger, "openclaw", "default");
  assert.equal(warns.length, 0);
});
