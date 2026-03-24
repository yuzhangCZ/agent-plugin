import type { OpenClawConfig } from "openclaw/plugin-sdk";

interface ResolveEffectiveReplyConfigResult {
  effectiveConfig: OpenClawConfig;
  streamDefaultsInjected: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function resolveEffectiveReplyConfig(config: OpenClawConfig): ResolveEffectiveReplyConfigResult {
  const root = isRecord(config) ? config : {};
  const agents = isRecord(root.agents) ? root.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const channels = isRecord(root.channels) ? root.channels : {};
  const messageBridge = isRecord(channels["message-bridge"]) ? channels["message-bridge"] : {};

  const injectBlockStreamingDefault = defaults.blockStreamingDefault === undefined;
  const injectBlockStreamingBreak = defaults.blockStreamingBreak === undefined;
  const injectChannelBlockStreaming = messageBridge.blockStreaming === undefined;
  const streamDefaultsInjected =
    injectBlockStreamingDefault || injectBlockStreamingBreak || injectChannelBlockStreaming;

  if (!streamDefaultsInjected) {
    return {
      effectiveConfig: config,
      streamDefaultsInjected: false,
    };
  }

  const effectiveConfig = {
    ...root,
    agents: {
      ...agents,
      defaults: {
        ...defaults,
        ...(injectBlockStreamingDefault ? { blockStreamingDefault: "on" } : {}),
        ...(injectBlockStreamingBreak ? { blockStreamingBreak: "text_end" } : {}),
      },
    },
    channels: {
      ...channels,
      "message-bridge": {
        ...messageBridge,
        ...(injectChannelBlockStreaming ? { blockStreaming: true } : {}),
      },
    },
  } as OpenClawConfig;

  return {
    effectiveConfig,
    streamDefaultsInjected: true,
  };
}
