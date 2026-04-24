export type ChatExecutionPath = "runtime_reply";

export type StreamMode = "runtime_reply_streaming" | "runtime_reply_non_streaming";

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
  canExecute: boolean;
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
      canExecute: true,
      executionPath: "runtime_reply",
      streamMode: params.streamingEnabled ? "runtime_reply_streaming" : "runtime_reply_non_streaming",
      reason: params.streamingEnabled ? "runtime_reply_available" : "plugin_streaming_disabled_runtime_reply",
    };
  }

  return {
    canExecute: false,
    executionPath: "runtime_reply",
    streamMode: params.streamingEnabled ? "runtime_reply_streaming" : "runtime_reply_non_streaming",
    reason: params.hasRouteResolver ? "missing_reply_runtime" : "missing_route_resolver",
  };
}
