import type { OpenClawConfig } from "openclaw/plugin-sdk";

export type StreamingSource = "default_on" | "explicit_on" | "explicit_off";

interface ResolveEffectiveReplyConfigResult {
  streamingEnabled: boolean;
  streamingSource: StreamingSource;
  effectiveConfig: OpenClawConfig;
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

  const streamingRaw = messageBridge["streaming"];
  let streamingEnabled = true;
  let streamingSource: StreamingSource = "default_on";
  if (streamingRaw === true) {
    streamingEnabled = true;
    streamingSource = "explicit_on";
  } else if (streamingRaw === false) {
    streamingEnabled = false;
    streamingSource = "explicit_off";
  } else if (streamingRaw !== undefined) {
    malformedConfigPaths.push("channels.message-bridge.streaming");
  }

  const normalizedConfig = {
    ...root,
    agents,
    channels: {
      ...channels,
      "message-bridge": messageBridge,
    },
  } as OpenClawConfig;

  const effectiveConfig = malformedConfigPaths.some((path) => path !== "channels.message-bridge.streaming")
    ? normalizedConfig
    : config;

  if (!streamingEnabled) {
    return {
      streamingEnabled,
      streamingSource,
      effectiveConfig,
      malformedConfigPaths,
    };
  }

  return {
    streamingEnabled,
    streamingSource,
    effectiveConfig,
    malformedConfigPaths,
  };
}
