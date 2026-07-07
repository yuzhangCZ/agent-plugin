import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { asRecord } from "./utils/type-guards.js";

export type StreamingSource = "default_on" | "explicit_on" | "explicit_off";

export const DEFAULT_BLOCK_STREAMING_CHUNK = {
  minChars: 8,
  maxChars: 24,
  breakPreference: "sentence",
} as const;

export const DEFAULT_BLOCK_STREAMING_COALESCE = {
  minChars: 8,
  maxChars: 24,
  idleMs: 40,
} as const;

interface ResolveEffectiveReplyConfigResult {
  streamingEnabled: boolean;
  streamingSource: StreamingSource;
  effectiveConfig: OpenClawConfig;
  streamDefaultsInjected: boolean;
  malformedConfigPaths: string[];
}

interface ReplyConfigShape {
  root: Record<string, unknown>;
  agents: Record<string, unknown>;
  defaults: Record<string, unknown>;
  channels: Record<string, unknown>;
  messageBridge: Record<string, unknown>;
  malformedConfigPaths: string[];
}

interface StreamingResolution {
  streamingEnabled: boolean;
  streamingSource: StreamingSource;
}

interface StreamDefaultsInjectionPlan {
  blockStreamingDefault: boolean;
  blockStreamingBreak: boolean;
  blockStreamingChunk: boolean;
  blockStreamingCoalesce: boolean;
}

function readOptionalRecord(value: unknown, path: string, malformedConfigPaths: string[]): Record<string, unknown> {
  const record = asRecord(value);
  if (value !== undefined && !record) {
    malformedConfigPaths.push(path);
  }
  return record ?? {};
}

function readReplyConfigShape(config: OpenClawConfig): ReplyConfigShape {
  const malformedConfigPaths: string[] = [];
  const root: Record<string, unknown> = asRecord(config) ?? {};
  const agents = readOptionalRecord(root.agents, "agents", malformedConfigPaths);
  const defaults = readOptionalRecord(agents.defaults, "agents.defaults", malformedConfigPaths);
  const channels = readOptionalRecord(root.channels, "channels", malformedConfigPaths);
  const messageBridge = readOptionalRecord(channels["message-bridge"], "channels.message-bridge", malformedConfigPaths);

  return {
    root,
    agents,
    defaults,
    channels,
    messageBridge,
    malformedConfigPaths,
  };
}

function resolveStreamingConfig(
  messageBridge: Record<string, unknown>,
  malformedConfigPaths: string[],
): StreamingResolution {
  const streamingRaw = messageBridge.streaming;
  if (streamingRaw === true) {
    return {
      streamingEnabled: true,
      streamingSource: "explicit_on",
    };
  }
  if (streamingRaw === false) {
    return {
      streamingEnabled: false,
      streamingSource: "explicit_off",
    };
  }
  if (streamingRaw !== undefined) {
    malformedConfigPaths.push("channels.message-bridge.streaming");
  }

  return {
    streamingEnabled: true,
    streamingSource: "default_on",
  };
}

function planStreamDefaultsInjection(defaults: Record<string, unknown>): StreamDefaultsInjectionPlan {
  return {
    blockStreamingDefault: defaults.blockStreamingDefault === undefined,
    blockStreamingBreak: defaults.blockStreamingBreak === undefined,
    blockStreamingChunk: defaults.blockStreamingChunk === undefined,
    blockStreamingCoalesce: defaults.blockStreamingCoalesce === undefined,
  };
}

function hasStreamDefaultsInjection(plan: StreamDefaultsInjectionPlan): boolean {
  return plan.blockStreamingDefault
    || plan.blockStreamingBreak
    || plan.blockStreamingChunk
    || plan.blockStreamingCoalesce;
}

function injectStreamDefaults(shape: ReplyConfigShape, plan: StreamDefaultsInjectionPlan): OpenClawConfig {
  return {
    ...shape.root,
    agents: {
      ...shape.agents,
      defaults: {
        ...shape.defaults,
        ...(plan.blockStreamingDefault ? { blockStreamingDefault: "on" } : {}),
        ...(plan.blockStreamingBreak ? { blockStreamingBreak: "text_end" } : {}),
        ...(plan.blockStreamingChunk ? { blockStreamingChunk: { ...DEFAULT_BLOCK_STREAMING_CHUNK } } : {}),
        ...(plan.blockStreamingCoalesce ? { blockStreamingCoalesce: { ...DEFAULT_BLOCK_STREAMING_COALESCE } } : {}),
      },
    },
    channels: {
      ...shape.channels,
      "message-bridge": {
        ...shape.messageBridge,
      },
    },
  } as OpenClawConfig;
}

export function resolveEffectiveReplyConfig(config: OpenClawConfig): ResolveEffectiveReplyConfigResult {
  const shape = readReplyConfigShape(config);
  const { streamingEnabled, streamingSource } = resolveStreamingConfig(shape.messageBridge, shape.malformedConfigPaths);
  if (!streamingEnabled) {
    return {
      streamingEnabled,
      streamingSource,
      effectiveConfig: config,
      streamDefaultsInjected: false,
      malformedConfigPaths: shape.malformedConfigPaths,
    };
  }

  const injectionPlan = planStreamDefaultsInjection(shape.defaults);
  const streamDefaultsInjected = hasStreamDefaultsInjection(injectionPlan);
  if (!streamDefaultsInjected) {
    return {
      streamingEnabled,
      streamingSource,
      effectiveConfig: config,
      streamDefaultsInjected: false,
      malformedConfigPaths: shape.malformedConfigPaths,
    };
  }

  return {
    streamingEnabled,
    streamingSource,
    effectiveConfig: injectStreamDefaults(shape, injectionPlan),
    streamDefaultsInjected: true,
    malformedConfigPaths: shape.malformedConfigPaths,
  };
}
