import type { OpenClawConfig } from "openclaw/plugin-sdk";

interface ResolveEffectiveReplyConfigResult {
  effectiveConfig: OpenClawConfig;
  streamDefaultsInjected: boolean;
  malformedConfigPaths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function resolveEffectiveReplyConfig(config: OpenClawConfig): ResolveEffectiveReplyConfigResult {
  const malformedConfigPaths: string[] = [];
  const root: Record<string, unknown> = isRecord(config) ? config : {};

  const agentsRaw = root["agents"];
  if (agentsRaw !== undefined && !isRecord(agentsRaw)) {
    malformedConfigPaths.push("agents");
  }
  const agents: Record<string, unknown> = isRecord(agentsRaw) ? agentsRaw : {};

  const defaultsRaw = agents["defaults"];
  if (defaultsRaw !== undefined && !isRecord(defaultsRaw)) {
    malformedConfigPaths.push("agents.defaults");
  }
  const defaults: Record<string, unknown> = isRecord(defaultsRaw) ? defaultsRaw : {};

  const channelsRaw = root["channels"];
  if (channelsRaw !== undefined && !isRecord(channelsRaw)) {
    malformedConfigPaths.push("channels");
  }
  const channels: Record<string, unknown> = isRecord(channelsRaw) ? channelsRaw : {};

  const messageBridgeRaw = channels["message-bridge"];
  if (messageBridgeRaw !== undefined && !isRecord(messageBridgeRaw)) {
    malformedConfigPaths.push("channels.message-bridge");
  }
  const messageBridge: Record<string, unknown> = isRecord(messageBridgeRaw) ? messageBridgeRaw : {};

  const injectBlockStreamingDefault = defaults["blockStreamingDefault"] === undefined;
  const injectBlockStreamingBreak = defaults["blockStreamingBreak"] === undefined;
  const injectChannelBlockStreaming = messageBridge["blockStreaming"] === undefined;
  const streamDefaultsInjected =
    injectBlockStreamingDefault || injectBlockStreamingBreak || injectChannelBlockStreaming;

  if (!streamDefaultsInjected) {
    return {
      effectiveConfig: config,
      streamDefaultsInjected: false,
      malformedConfigPaths,
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
    malformedConfigPaths,
  };
}
