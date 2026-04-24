import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveReplyConfig } from "../../src/resolveEffectiveReplyConfig.ts";

test("resolveEffectiveReplyConfig keeps config untouched when streaming defaults are absent", () => {
  const input = {
    agents: {
      defaults: {},
    },
    channels: {},
  };

  const result = resolveEffectiveReplyConfig(input);

  assert.equal(result.streamingEnabled, true);
  assert.equal(result.streamingSource, "default_on");
  assert.equal(result.effectiveConfig, input);
  assert.deepEqual(result.effectiveConfig.agents.defaults, {});
  assert.equal(input.channels["message-bridge"], undefined);
});

test("resolveEffectiveReplyConfig preserves explicit legacy block streaming keys without injecting defaults", () => {
  const input = {
    agents: {
      defaults: {
        blockStreamingDefault: "on",
        blockStreamingBreak: "message_end",
        blockStreamingChunk: {
          minChars: 50,
          maxChars: 80,
          breakPreference: "sentence",
        },
        blockStreamingCoalesce: {
          minChars: 60,
          maxChars: 100,
          idleMs: 90,
        },
      },
    },
    channels: {
      "message-bridge": {
        streaming: true,
      },
    },
  };

  const result = resolveEffectiveReplyConfig(input);

  assert.equal(result.streamingEnabled, true);
  assert.equal(result.streamingSource, "explicit_on");
  assert.equal(result.effectiveConfig, input);
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingDefault, "on");
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingBreak, "message_end");
  assert.equal(result.effectiveConfig.channels["message-bridge"].streaming, true);
});

test("resolveEffectiveReplyConfig disables plugin streaming when channels.message-bridge.streaming=false", () => {
  const input = {
    agents: {
      defaults: {
        blockStreamingDefault: "on",
      },
    },
    channels: {
      "message-bridge": {
        streaming: false,
      },
    },
  };

  const result = resolveEffectiveReplyConfig(input);

  assert.equal(result.streamingEnabled, false);
  assert.equal(result.streamingSource, "explicit_off");
  assert.equal(result.effectiveConfig, input);
});

test("resolveEffectiveReplyConfig does not backfill partially missing legacy block keys", () => {
  const input = {
    agents: {
      defaults: {
        blockStreamingBreak: "message_end",
      },
    },
    channels: {},
  };

  const result = resolveEffectiveReplyConfig(input);

  assert.equal(result.streamingEnabled, true);
  assert.equal(result.streamingSource, "default_on");
  assert.equal(result.effectiveConfig, input);
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingDefault, undefined);
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingBreak, "message_end");
});

test("resolveEffectiveReplyConfig reports malformed config paths and normalizes shape", () => {
  const input = {
    agents: "invalid",
    channels: {
      "message-bridge": "invalid",
    },
  };

  const result = resolveEffectiveReplyConfig(input);

  assert.equal(result.streamingEnabled, true);
  assert.equal(result.streamingSource, "default_on");
  assert.deepEqual(result.malformedConfigPaths, ["agents", "channels.message-bridge"]);
  assert.notEqual(result.effectiveConfig, input);
  assert.deepEqual(result.effectiveConfig.agents, {});
  assert.deepEqual(result.effectiveConfig.channels["message-bridge"], {});
  assert.equal(input.agents, "invalid");
});

test("resolveEffectiveReplyConfig treats malformed streaming value as default_on and reports path", () => {
  const input = {
    channels: {
      "message-bridge": {
        streaming: "invalid",
      },
    },
  };

  const result = resolveEffectiveReplyConfig(input);

  assert.equal(result.streamingEnabled, true);
  assert.equal(result.streamingSource, "default_on");
  assert.deepEqual(result.malformedConfigPaths, ["channels.message-bridge.streaming"]);
  assert.equal(result.effectiveConfig, input);
});
