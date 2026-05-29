import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import type {
  ProviderFact,
  ProviderTerminalResult,
} from "@wecode/bridge-runtime-sdk";

import type { BridgeLogger, MessageBridgeResolvedAccount } from "../types.js";
import type { SessionRegistry } from "../session/SessionRegistry.js";
import type { AsyncQueueController } from "./async-queue.js";
import type { Deferred } from "./deferred.js";

/** OpenClaw subagent fallback runtime 的最小能力边界。 */
export type SubagentRuntime = {
  run(params: {
    sessionKey: string;
    message: string;
    deliver: boolean;
    idempotencyKey: string;
  }): Promise<{ runId: string }>;
  waitForRun(params: { runId: string; timeoutMs: number }): Promise<{ status: string; error?: string }>;
  getSessionMessages(params: { sessionKey: string; limit: number }): Promise<{ messages: unknown[] }>;
  deleteSession?(params: { sessionKey: string }): Promise<void>;
};

/** OpenClaw agent stream 事件的兼容输入形态。 */
export type ToolAgentEvent = {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: unknown;
};

/** OpenClaw gateway/system 事件的兼容输入形态。 */
export type RuntimeGatewayEvent = {
  event?: string;
  type?: string;
  payload?: unknown;
  data?: unknown;
};

/** message-bridge 专用路由解析结果。 */
export type MessageBridgeRoute = {
  accountId: string;
  agentId: string;
  sessionKey?: string;
  raw: Record<string, unknown>;
};

/** 单个 OpenClaw tool call 在 fact 投影前的累积状态。 */
export interface ActiveToolState {
  toolCallId: string;
  toolName: string;
  partId: string;
  title?: string;
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

/** 单次 provider run 的本地运行态和输出边界。 */
export interface ActiveRunState {
  toolSessionId: string;
  sessionKey: string;
  runId: string;
  messageId: string;
  textPartId: string;
  thinkingPartId: string;
  queue: AsyncQueueController<ProviderFact>;
  result: Deferred<ProviderTerminalResult>;
  started: boolean;
  completed: boolean;
  abortRequested: boolean;
  accumulatedText: string;
  accumulatedThinking: string;
  textDeltaCount: number;
  pendingFinalText: string | null;
  pendingToolResultTarget: string | null;
  streamingEnabled: boolean;
  replyDispatcherOwnsAssistantText: boolean;
  titleEmitted: boolean;
  toolStates: Map<string, ActiveToolState>;
}

/** OpenClaw provider adapter 的装配依赖。 */
export interface OpenClawProviderAdapterOptions {
  account: MessageBridgeResolvedAccount;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  logger: BridgeLogger;
  sessionRegistry: SessionRegistry;
  getSubagentRuntime: () => SubagentRuntime | null;
  isOnline: () => boolean;
  onStreamingOutcome?: (outcome: {
    executionPath: "runtime_reply" | "subagent_fallback";
    streamingEnabled: boolean;
    observedRealChunk: boolean;
  }) => void;
}
