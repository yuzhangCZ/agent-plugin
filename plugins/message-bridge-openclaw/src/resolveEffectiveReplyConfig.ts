import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { asRecord } from "./utils/type-guards.js";

export type StreamingSource = "default_on" | "explicit_on" | "explicit_off";

export const DEFAULT_BLOCK_STREAMING_CHUNK = {
  minChars: 120,
  maxChars: 260,
  breakPreference: "newline",
} as const;

export const DEFAULT_BLOCK_STREAMING_COALESCE = {
  minChars: 180,
  maxChars: 360,
  idleMs: 160,
} as const;

interface ResolveEffectiveReplyConfigResult {
  streamingEnabled: boolean;
  streamingSource: StreamingSource;
  effectiveConfig: OpenClawConfig;
  streamDefaultsInjected: boolean;
  malformedConfigPaths: string[];
}

export function resolveEffectiveReplyConfig(config: OpenClawConfig): ResolveEffectiveReplyConfigResult {
  const malformedConfigPaths: string[] = [];
  const root: Record<string, unknown> = asRecord(config) ?? {};

  const agentsRaw = root["agents"];
  if (agentsRaw !== undefined && !asRecord(agentsRaw)) {
    malformedConfigPaths.push("agents");
  }
  const agents: Record<string, unknown> = asRecord(agentsRaw) ?? {};

  const defaultsRaw = agents["defaults"];
  if (defaultsRaw !== undefined && !asRecord(defaultsRaw)) {
    malformedConfigPaths.push("agents.defaults");
  }
  const defaults: Record<string, unknown> = asRecord(defaultsRaw) ?? {};

  const channelsRaw = root["channels"];
  if (channelsRaw !== undefined && !asRecord(channelsRaw)) {
    malformedConfigPaths.push("channels");
  }
  const channels: Record<string, unknown> = asRecord(channelsRaw) ?? {};

  const messageBridgeRaw = channels["message-bridge"];
  if (messageBridgeRaw !== undefined && !asRecord(messageBridgeRaw)) {
    malformedConfigPaths.push("channels.message-bridge");
  }
  const messageBridge: Record<string, unknown> = asRecord(messageBridgeRaw) ?? {};

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

  if (!streamingEnabled) {
    return {
      streamingEnabled,
      streamingSource,
      effectiveConfig: config,
      streamDefaultsInjected: false,
      malformedConfigPaths,
    };
  }

  const injectBlockStreamingDefault = defaults["blockStreamingDefault"] === undefined;
  const injectBlockStreamingBreak = defaults["blockStreamingBreak"] === undefined;
  const injectBlockStreamingChunk = defaults["blockStreamingChunk"] === undefined;
  const injectBlockStreamingCoalesce = defaults["blockStreamingCoalesce"] === undefined;
  const streamDefaultsInjected =
    injectBlockStreamingDefault ||
    injectBlockStreamingBreak ||
    injectBlockStreamingChunk ||
    injectBlockStreamingCoalesce;

  if (!streamDefaultsInjected) {
    return {
      streamingEnabled,
      streamingSource,
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
        ...(injectBlockStreamingChunk ? { blockStreamingChunk: { ...DEFAULT_BLOCK_STREAMING_CHUNK } } : {}),
        ...(injectBlockStreamingCoalesce ? { blockStreamingCoalesce: { ...DEFAULT_BLOCK_STREAMING_COALESCE } } : {}),
      },
    },
    channels: {
      ...channels,
      "message-bridge": {
        ...messageBridge,
      },
    },
  } as OpenClawConfig;

  return {
    streamingEnabled,
    streamingSource,
    effectiveConfig,
    streamDefaultsInjected: true,
    malformedConfigPaths,
  };
}
