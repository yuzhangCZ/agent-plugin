export interface MessageBridgeReconnectConfig {
  baseMs: number;
  maxMs: number;
  exponential: boolean;
}

export interface MessageBridgeGatewayConfig {
  url: string;
  heartbeatIntervalMs: number;
  reconnect: MessageBridgeReconnectConfig;
}

export interface MessageBridgeAuthConfig {
  ak: string;
  sk: string;
}

export interface MessageBridgeAccountConfig {
  enabled: boolean;
  debug: boolean;
  streaming?: boolean;
  name?: string;
  gateway: MessageBridgeGatewayConfig;
  auth: MessageBridgeAuthConfig;
  agentIdPrefix: string;
  runTimeoutMs: number;
}

export interface MessageBridgeResolvedAccount extends MessageBridgeAccountConfig {
  accountId: string;
}

export type MessageBridgeProbeState = "ready" | "rejected" | "connect_error" | "timeout" | "connecting" | "cancelled";

export type MessageBridgeRuntimePhase = "idle" | "connecting" | "ready" | "stopping";

export interface MessageBridgeProbeResult {
  ok: boolean;
  state: MessageBridgeProbeState;
  latencyMs: number;
  reason?: string;
}

export interface MessageBridgeSessionRecord {
  toolSessionId: string;
  sessionKey: string;
  welinkSessionId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageBridgeStatusSnapshot {
  accountId: string;
  running: boolean;
  connected: boolean;
  runtimePhase?: MessageBridgeRuntimePhase;
  routeResolverAvailable?: boolean;
  replyRuntimeAvailable?: boolean;
  streamingPathHealthy?: boolean;
  streamingPathReason?:
    | "runtime_reply_available"
    | "runtime_reply_final_only"
    | "plugin_streaming_disabled_runtime_reply"
    | "missing_route_resolver"
    | "missing_reply_runtime";
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  lastReadyAt: number | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  lastHeartbeatAt: number | null;
  probe: MessageBridgeProbeResult | null;
  lastProbeAt: number | null;
}

export type BridgeLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};
