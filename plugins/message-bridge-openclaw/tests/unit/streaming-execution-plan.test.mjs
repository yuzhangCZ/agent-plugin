import test from "node:test";
import assert from "node:assert/strict";
import { resolveStreamingExecutionPlan } from "../../src/resolveStreamingExecutionPlan.ts";

test("resolveStreamingExecutionPlan uses runtime reply streaming when enabled and runtime reply is available", () => {
  const result = resolveStreamingExecutionPlan({
    streamingEnabled: true,
    hasRouteResolver: true,
    hasReplyRuntime: true,
  });

  assert.deepEqual(result, {
    canExecute: true,
    executionPath: "runtime_reply",
    streamMode: "runtime_reply_streaming",
    reason: "runtime_reply_available",
  });
});

test("resolveStreamingExecutionPlan keeps runtime path but switches to non-streaming mode when plugin streaming is disabled", () => {
  const result = resolveStreamingExecutionPlan({
    streamingEnabled: false,
    hasRouteResolver: true,
    hasReplyRuntime: true,
  });

  assert.deepEqual(result, {
    canExecute: true,
    executionPath: "runtime_reply",
    streamMode: "runtime_reply_non_streaming",
    reason: "plugin_streaming_disabled_runtime_reply",
  });
});

test("resolveStreamingExecutionPlan marks plan as non-executable when runtime reply is unavailable", () => {
  assert.deepEqual(
    resolveStreamingExecutionPlan({
      streamingEnabled: true,
      hasRouteResolver: true,
      hasReplyRuntime: false,
    }),
    {
      canExecute: false,
      executionPath: "runtime_reply",
      streamMode: "runtime_reply_streaming",
      reason: "missing_reply_runtime",
    },
  );

  assert.deepEqual(
    resolveStreamingExecutionPlan({
      streamingEnabled: true,
      hasRouteResolver: false,
      hasReplyRuntime: false,
    }),
    {
      canExecute: false,
      executionPath: "runtime_reply",
      streamMode: "runtime_reply_streaming",
      reason: "missing_route_resolver",
    },
  );
});
