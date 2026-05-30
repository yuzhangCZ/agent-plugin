import assert from "node:assert/strict";
import test from "node:test";
import { KNOWN_CHANNELS, isKnownChannel } from "../../src/contracts/transport.ts";
import { MESSAGE_BRIDGE_CHANNEL, resolveRegisterMetadata, warnUnknownChannel } from "../../src/runtime/RegisterMetadata.ts";

test("known channels only include openclaw", () => {
  assert.deepEqual(KNOWN_CHANNELS, ["openclaw"]);
  assert.equal(isKnownChannel("openclaw"), true);
  assert.equal(isKnownChannel("codeagent"), false);
});

test("register metadata default channel is openclaw", () => {
  assert.equal(MESSAGE_BRIDGE_CHANNEL, "openclaw");
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
    channel: "openclaw",
    toolVersion: "1.2.3",
    pluginVersion: "unknown",
  });
  assert.equal("deviceName" in metadata, false);
  assert.equal("macAddress" in metadata, false);
});

test("warnUnknownChannel emits warning for unknown value and stays non-blocking", () => {
  const warns = [];
  const logger = {
    info() {},
    warn(message, meta) {
      warns.push({ message, meta });
    },
    error() {},
  };

  warnUnknownChannel(logger, "legacy-channel", "default");
  const warnLog = warns.find((entry) => entry.message === "runtime.register.channel.unknown");
  assert.ok(warnLog);
  assert.equal(warnLog.meta.channel, "legacy-channel");
  assert.deepEqual(warnLog.meta.knownChannels, ["openclaw"]);
  assert.equal(warnLog.meta.accountId, "default");
});

test("warnUnknownChannel does nothing for known value", () => {
  const warns = [];
  const logger = {
    info() {},
    warn(message, meta) {
      warns.push({ message, meta });
    },
    error() {},
  };

  warnUnknownChannel(logger, "openclaw", "default");
  assert.equal(warns.length, 0);
});
