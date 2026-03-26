import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BLOCK_STREAMING_CHUNK,
  DEFAULT_BLOCK_STREAMING_COALESCE,
  resolveEffectiveReplyConfig,
} from "../../src/resolveEffectiveReplyConfig.ts";

test("resolveEffectiveReplyConfig injects block streaming defaults when missing", () => {
  const input = {
    agents: {
      defaults: {},
    },
    channels: {},
  };

  const result = resolveEffectiveReplyConfig(input);

  assert.equal(result.streamingEnabled, true);
  assert.equal(result.streamingSource, "default_on");
  assert.equal(result.streamDefaultsInjected, true);
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingDefault, "on");
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingBreak, "text_end");
  assert.deepEqual(result.effectiveConfig.agents.defaults.blockStreamingChunk, DEFAULT_BLOCK_STREAMING_CHUNK);
  assert.deepEqual(result.effectiveConfig.agents.defaults.blockStreamingCoalesce, DEFAULT_BLOCK_STREAMING_COALESCE);
  assert.equal(Object.hasOwn(result.effectiveConfig.channels["message-bridge"], "blockStreaming"), false);
  assert.equal(input.channels["message-bridge"], undefined);
});

test("resolveEffectiveReplyConfig preserves explicit streaming profile values without injecting", () => {
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
  assert.equal(result.streamDefaultsInjected, false);
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
  assert.equal(result.streamDefaultsInjected, false);
  assert.equal(result.effectiveConfig, input);
});

test("resolveEffectiveReplyConfig only fills missing keys and keeps existing break mode", () => {
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
  assert.equal(result.streamDefaultsInjected, true);
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingDefault, "on");
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingBreak, "message_end");
  assert.deepEqual(result.effectiveConfig.agents.defaults.blockStreamingChunk, DEFAULT_BLOCK_STREAMING_CHUNK);
  assert.deepEqual(result.effectiveConfig.agents.defaults.blockStreamingCoalesce, DEFAULT_BLOCK_STREAMING_COALESCE);
  assert.equal(Object.hasOwn(result.effectiveConfig.channels["message-bridge"], "blockStreaming"), false);
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
  assert.equal(result.streamDefaultsInjected, true);
  assert.deepEqual(result.malformedConfigPaths, ["agents", "channels.message-bridge"]);
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingDefault, "on");
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingBreak, "text_end");
  assert.equal(Object.hasOwn(result.effectiveConfig.channels["message-bridge"], "blockStreaming"), false);
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
  assert.equal(result.streamDefaultsInjected, true);
  assert.deepEqual(result.malformedConfigPaths, ["channels.message-bridge.streaming"]);
});
