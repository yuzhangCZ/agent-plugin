import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveReplyConfig } from "../../dist/resolveEffectiveReplyConfig.js";

test("resolveEffectiveReplyConfig injects block streaming defaults when missing", () => {
  const input = {
    agents: {
      defaults: {},
    },
    channels: {},
  };

  const result = resolveEffectiveReplyConfig(input);

  assert.equal(result.streamDefaultsInjected, true);
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingDefault, "on");
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingBreak, "text_end");
  assert.equal(result.effectiveConfig.channels["message-bridge"].blockStreaming, true);
  assert.equal(input.channels["message-bridge"], undefined);
});

test("resolveEffectiveReplyConfig preserves explicit off and false values", () => {
  const input = {
    agents: {
      defaults: {
        blockStreamingDefault: "off",
        blockStreamingBreak: "message_end",
      },
    },
    channels: {
      "message-bridge": {
        blockStreaming: false,
      },
    },
  };

  const result = resolveEffectiveReplyConfig(input);

  assert.equal(result.streamDefaultsInjected, false);
  assert.equal(result.effectiveConfig, input);
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingDefault, "off");
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingBreak, "message_end");
  assert.equal(result.effectiveConfig.channels["message-bridge"].blockStreaming, false);
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

  assert.equal(result.streamDefaultsInjected, true);
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingDefault, "on");
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingBreak, "message_end");
  assert.equal(result.effectiveConfig.channels["message-bridge"].blockStreaming, true);
});

test("resolveEffectiveReplyConfig reports malformed config paths and normalizes shape", () => {
  const input = {
    agents: "invalid",
    channels: {
      "message-bridge": "invalid",
    },
  };

  const result = resolveEffectiveReplyConfig(input);

  assert.equal(result.streamDefaultsInjected, true);
  assert.deepEqual(result.malformedConfigPaths, ["agents", "channels.message-bridge"]);
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingDefault, "on");
  assert.equal(result.effectiveConfig.agents.defaults.blockStreamingBreak, "text_end");
  assert.equal(result.effectiveConfig.channels["message-bridge"].blockStreaming, true);
});
