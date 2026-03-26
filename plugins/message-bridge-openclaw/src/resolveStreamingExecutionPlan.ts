export type ChatExecutionPath = "runtime_reply" | "subagent_fallback";

export type StreamMode = "runtime_block_streaming" | "fallback_non_streaming";

export type ChatExecutionPathReason =
  | "runtime_reply_available"
  | "plugin_streaming_disabled_runtime_reply"
  | "missing_route_resolver"
  | "missing_reply_runtime";

export interface ResolveStreamingExecutionPlanParams {
  streamingEnabled: boolean;
  hasRouteResolver: boolean;
  hasReplyRuntime: boolean;
}

export interface ResolveStreamingExecutionPlanResult {
  executionPath: ChatExecutionPath;
  streamMode: StreamMode;
  reason: ChatExecutionPathReason;
}

export function resolveStreamingExecutionPlan(
  params: ResolveStreamingExecutionPlanParams,
): ResolveStreamingExecutionPlanResult {
  const hasRuntimeReply = params.hasRouteResolver && params.hasReplyRuntime;
  if (hasRuntimeReply) {
    return {
      executionPath: "runtime_reply",
      streamMode: params.streamingEnabled ? "runtime_block_streaming" : "fallback_non_streaming",
      reason: params.streamingEnabled ? "runtime_reply_available" : "plugin_streaming_disabled_runtime_reply",
    };
  }

  return {
    executionPath: "subagent_fallback",
    streamMode: "fallback_non_streaming",
    reason: params.hasRouteResolver ? "missing_reply_runtime" : "missing_route_resolver",
  };
}
