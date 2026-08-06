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

interface OptionalRecordReadResult {
  record: Record<string, unknown>;
  malformedConfigPath?: string;
}

// OpenClaw 配置来自用户文件，边界上只接受对象；异常形态记录路径后按空对象继续 fail-closed 注入默认值。
function readOptionalRecord(value: unknown, path: string): OptionalRecordReadResult {
  const record = asRecord(value);
  if (value !== undefined && !record) {
    return {
      record: {},
      malformedConfigPath: path,
    };
  }
  return { record: record ?? {} };
}

function collectMalformedConfigPaths(...results: OptionalRecordReadResult[]): string[] {
  return results
    .map((result) => result.malformedConfigPath)
    .filter((path): path is string => path !== undefined);
}

// 将散落在 agents/channels 下的 reply 相关配置收敛成稳定 shape，后续逻辑不再重复做对象收窄。
function readReplyConfigShape(config: OpenClawConfig): ReplyConfigShape {
  const root: Record<string, unknown> = asRecord(config) ?? {};
  const agentsResult = readOptionalRecord(root.agents, "agents");
  const defaultsResult = readOptionalRecord(agentsResult.record.defaults, "agents.defaults");
  const channelsResult = readOptionalRecord(root.channels, "channels");
  const messageBridgeResult = readOptionalRecord(channelsResult.record["message-bridge"], "channels.message-bridge");

  return {
    root,
    agents: agentsResult.record,
    defaults: defaultsResult.record,
    channels: channelsResult.record,
    messageBridge: messageBridgeResult.record,
    malformedConfigPaths: collectMalformedConfigPaths(
      agentsResult,
      defaultsResult,
      channelsResult,
      messageBridgeResult,
    ),
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

  // streaming 字段缺失或格式异常时维持默认开启，避免配置拼写问题直接关闭 reply runtime 流式能力。
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

// 只补缺失字段，不覆盖用户已显式配置的 block streaming profile。
function injectStreamDefaults(shape: ReplyConfigShape, plan: StreamDefaultsInjectionPlan): OpenClawConfig {
  const effectiveConfig: OpenClawConfig = {
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
  };
  return effectiveConfig;
}

/**
 * 解析 OpenClaw reply runtime 的有效配置，并在需要时注入 block streaming 默认值。
 * @remarks
 * 该函数是宿主配置进入 runtime reply 路径前的统一边界：既要报告 malformed 路径，也要保证下游拿到可工作的默认配置。
 */
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
