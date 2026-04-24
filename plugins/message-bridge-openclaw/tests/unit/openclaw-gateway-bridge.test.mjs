import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { OpenClawGatewayBridge } from "../../src/OpenClawGatewayBridge.ts";

class FakeGatewayConnection extends EventEmitter {
  state = "READY";
  sent = [];

  async connect() {
    this.state = "READY";
    this.emit("stateChange", "READY");
  }

  disconnect() {
    this.state = "DISCONNECTED";
    this.emit("stateChange", "DISCONNECTED");
  }

  send(message, context) {
    this.sent.push({ message, context });
  }

  getState() {
    return this.state;
  }

  isConnected() {
    return this.state === "CONNECTED" || this.state === "READY";
  }
}

function createLogger() {
  const records = {
    info: [],
    warn: [],
    error: [],
    debug: [],
  };
  return {
    records,
    info(message, meta) {
      records.info.push({ message, meta });
    },
    warn(message, meta) {
      records.warn.push({ message, meta });
    },
    error(message, meta) {
      records.error.push({ message, meta });
    },
    debug(message, meta) {
      records.debug.push({ message, meta });
    },
  };
}

function createAccount() {
  return {
    accountId: "default",
    enabled: true,
    debug: false,
    streaming: true,
    gateway: {
      url: "ws://localhost:8081/ws/agent",
      heartbeatIntervalMs: 30_000,
      reconnect: {
        baseMs: 1_000,
        maxMs: 30_000,
        exponential: true,
      },
    },
    auth: {
      ak: "ak",
      sk: "sk",
    },
    agentIdPrefix: "message-bridge",
    runTimeoutMs: 1_000,
  };
}

function createRuntimeReplyRuntime(dispatchImpl) {
  return {
    channel: {
      routing: {
        resolveAgentRoute() {
          return {
            agentId: "agent_1",
            accountId: "default",
          };
        },
      },
      reply: {
        resolveEnvelopeFormatOptions() {
          return {};
        },
        formatAgentEnvelope({ body }) {
          return body;
        },
        finalizeInboundContext(context) {
          return context;
        },
        async dispatchReplyWithBufferedBlockDispatcher(args) {
          await dispatchImpl(args);
        },
      },
    },
  };
}

function createRuntimeEventBus() {
  const listeners = new Set();
  return {
    runtimeEvents: {
      onAgentEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

function createBridge({ runtime, connection = new FakeGatewayConnection(), account = {}, config = {}, logger = createLogger() } = {}) {
  const bridge = new OpenClawGatewayBridge({
    account: {
      ...createAccount(),
      ...account,
    },
    config,
    logger,
    runtime: runtime ?? createRuntimeReplyRuntime(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "default final" }, { kind: "final" });
    }),
    setStatus() {},
    connectionFactory: () => connection,
  });

  return { bridge, connection, logger };
}

function getToolEvents(connection) {
  return connection.sent
    .map(({ message }) => message)
    .filter((message) => message.type === "tool_event");
}

function assertAssistantTextUpdated(events, updatedIndex, expectedText) {
  const updatedEvent = events[updatedIndex]?.event;
  assert.ok(updatedEvent);
  assert.equal(updatedEvent.type, "message.part.updated");
  assert.equal(updatedEvent.properties?.part?.type, "text");
  assert.equal(updatedEvent.properties?.part?.text, expectedText);
}

function assertAssistantTextSeed(events, updatedIndex) {
  const updatedEvent = events[updatedIndex]?.event;
  assert.ok(updatedEvent);

  const seedEvent = events[updatedIndex - 1]?.event;
  assert.ok(seedEvent);
  assert.equal(seedEvent.type, "message.part.updated");
  assert.equal(seedEvent.properties?.part?.type, "text");
  assert.equal(seedEvent.properties?.part?.text, "");
  assert.equal(seedEvent.properties?.delta, "");
  assert.equal(seedEvent.properties?.part?.messageID, updatedEvent.properties?.part?.messageID);
  assert.equal(seedEvent.properties?.part?.id, updatedEvent.properties?.part?.id);
}

function findAssistantTextUpdateIndex(events, expectedText, fromIndex = 0) {
  return events.findIndex((message, index) => {
    return index >= fromIndex
      && message.event.type === "message.part.updated"
      && message.event.properties?.part?.text === expectedText;
  });
}

function assertSameAssistantTextPart(events, firstIndex, secondIndex) {
  const firstEvent = events[firstIndex]?.event;
  const secondEvent = events[secondIndex]?.event;
  assert.ok(firstEvent);
  assert.ok(secondEvent);
  assert.equal(firstEvent.properties?.part?.messageID, secondEvent.properties?.part?.messageID);
  assert.equal(firstEvent.properties?.part?.id, secondEvent.properties?.part?.id);
}

test("create_session emits session.updated before session_created", async () => {
  const { bridge, connection } = createBridge();

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_create_1",
    action: "create_session",
    payload: {
      metadata: {
        title: "Session Title",
      },
    },
  });

  assert.equal(connection.sent[0].message.type, "tool_event");
  assert.equal(connection.sent[0].message.event.type, "session.updated");
  assert.equal(connection.sent[0].message.event.properties.info.title, "Session Title");
  assert.equal(connection.sent[1].message.type, "session_created");
  assert.equal(connection.sent[1].message.toolSessionId, connection.sent[0].message.toolSessionId);
});

test("runtime reply chat emits assistant text events from partial replies and reuses final as truth source", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ replyOptions, dispatcherOptions }) => {
    assert.equal(typeof replyOptions.onPartialReply, "function");
    replyOptions.onPartialReply("hello");
    replyOptions.onPartialReply("hello world");
    await dispatcherOptions.deliver({ text: "hello world" }, { kind: "final" });
  });
  const { bridge, connection } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_2",
    action: "chat",
    payload: {
      toolSessionId: "ses_tool_2",
      text: "hello",
    },
  });

  const toolEvents = getToolEvents(connection);
  const assistantMessageUpdatedIndex = toolEvents.findIndex((message) => {
    return message.event.type === "message.updated" && message.event.properties?.info?.role === "assistant";
  });
  const firstAssistantTextUpdateIndex = findAssistantTextUpdateIndex(toolEvents, "hello", assistantMessageUpdatedIndex);
  const finalAssistantTextUpdateIndex = findAssistantTextUpdateIndex(toolEvents, "hello world", assistantMessageUpdatedIndex);
  assert.notEqual(firstAssistantTextUpdateIndex, -1);
  assert.equal(finalAssistantTextUpdateIndex, -1);
  assertAssistantTextSeed(toolEvents, firstAssistantTextUpdateIndex);
  assertAssistantTextUpdated(toolEvents, firstAssistantTextUpdateIndex, "hello");
  const streamedDeltaIndex = toolEvents.findIndex((message) => {
    return message.event.type === "message.part.delta" && message.event.properties?.delta === " world";
  });
  assert.notEqual(streamedDeltaIndex, -1);
  assert.equal(toolEvents[streamedDeltaIndex].event.properties.field, "text");
  assert.ok(streamedDeltaIndex > firstAssistantTextUpdateIndex);

  const updatedPartEvents = connection.sent
    .map(({ message }) => message)
    .filter((message) => message.type === "tool_event" && message.event.type === "message.part.updated");

  for (const message of updatedPartEvents) {
    assert.equal(typeof message.event.properties.time, "number");
  }
});

test("partial plus identical final emits seeded first text update and skips duplicate final replay", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ replyOptions, dispatcherOptions }) => {
    assert.equal(typeof replyOptions.onPartialReply, "function");
    replyOptions.onPartialReply("hello");
    await dispatcherOptions.deliver({ text: "hello" }, { kind: "final" });
  });
  const { bridge, connection } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_single_block_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_single_block_1",
      text: "hello",
    },
  });

  const toolEvents = getToolEvents(connection);
  const assistantMessageUpdatedIndex = toolEvents.findIndex((message) => {
    return message.event.type === "message.updated" && message.event.properties?.info?.role === "assistant";
  });
  const assistantTextUpdateIndexes = toolEvents
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => {
      return index >= assistantMessageUpdatedIndex
        && message.event.type === "message.part.updated"
        && message.event.properties?.part?.text === "hello";
    })
    .map(({ index }) => index);

  assert.equal(assistantTextUpdateIndexes.length, 1);
  assertAssistantTextSeed(toolEvents, assistantTextUpdateIndexes[0]);
  assertAssistantTextUpdated(toolEvents, assistantTextUpdateIndexes[0], "hello");
});

test("empty final does not wipe a non-empty partial reply", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ replyOptions, dispatcherOptions }) => {
    assert.equal(typeof replyOptions.onPartialReply, "function");
    replyOptions.onPartialReply("hello");
    await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
  });
  const { bridge, connection } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_empty_final_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_empty_final_1",
      text: "hello",
    },
  });

  const toolEvents = getToolEvents(connection);
  assert.notEqual(findAssistantTextUpdateIndex(toolEvents, "hello"), -1);
});

test("runtime reply final-only emits seeded first text update before final text", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "hello only final" }, { kind: "final" });
  });
  const { bridge, connection } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_final_only_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_final_only_1",
      text: "hello",
    },
  });

  const toolEvents = getToolEvents(connection);
  const assistantMessageUpdatedIndex = toolEvents.findIndex((message) => {
    return message.event.type === "message.updated" && message.event.properties?.info?.role === "assistant";
  });
  const finalAssistantTextUpdateIndex = findAssistantTextUpdateIndex(
    toolEvents,
    "hello only final",
    assistantMessageUpdatedIndex,
  );

  assert.notEqual(finalAssistantTextUpdateIndex, -1);
  assertAssistantTextSeed(toolEvents, finalAssistantTextUpdateIndex);
  assertAssistantTextUpdated(toolEvents, finalAssistantTextUpdateIndex, "hello only final");
});

test("partial shrink emits full updated correction before completion", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ replyOptions, dispatcherOptions }) => {
    assert.equal(typeof replyOptions.onPartialReply, "function");
    replyOptions.onPartialReply("hello world");
    replyOptions.onPartialReply("hello");
    await dispatcherOptions.deliver({ text: "hello" }, { kind: "final" });
  });
  const { bridge, connection } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_partial_shrink_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_partial_shrink_1",
      text: "hello",
    },
  });

  const toolEvents = getToolEvents(connection);
  const firstIndex = findAssistantTextUpdateIndex(toolEvents, "hello world");
  const correctedIndex = findAssistantTextUpdateIndex(toolEvents, "hello", firstIndex + 1);
  assert.notEqual(firstIndex, -1);
  assert.notEqual(correctedIndex, -1);
  assertAssistantTextUpdated(toolEvents, firstIndex, "hello world");
  assertAssistantTextUpdated(toolEvents, correctedIndex, "hello");

  const assistantCompletedIndex = toolEvents.findIndex((message, index) => {
    return index > firstIndex
      && message.event.type === "message.updated"
      && message.event.properties?.info?.role === "assistant"
      && message.event.properties?.info?.time?.completed;
  });
  assert.notEqual(assistantCompletedIndex, -1);
  assert.ok(correctedIndex < assistantCompletedIndex);
});

test("partial and different final logs finalReconciled=true before completion", async () => {
  const logger = createLogger();
  const runtime = createRuntimeReplyRuntime(async ({ replyOptions, dispatcherOptions }) => {
    assert.equal(typeof replyOptions.onPartialReply, "function");
    replyOptions.onPartialReply("hello");
    await dispatcherOptions.deliver({ text: "hello world" }, { kind: "final" });
  });
  const { bridge } = createBridge({ runtime, logger });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_final_reconciled_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_final_reconciled_1",
      text: "hello",
    },
  });

  const completedLog = logger.records.info.findLast((entry) => entry.message === "bridge.chat.completed");
  assert.ok(completedLog);
  assert.equal(completedLog.meta?.finalReconciled, true);
  assert.equal(completedLog.meta?.responseSource, "partial_streaming");
});

test("block payloads are ignored for assistant text and final-only path still completes", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "ignored block" }, { kind: "block" });
    await dispatcherOptions.deliver({ text: "visible final" }, { kind: "final" });
  });
  const { bridge, connection } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_block_ignored_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_block_ignored_1",
      text: "hello",
    },
  });

  const toolEvents = getToolEvents(connection);
  assert.equal(findAssistantTextUpdateIndex(toolEvents, "ignored block"), -1);
  assert.notEqual(findAssistantTextUpdateIndex(toolEvents, "visible final"), -1);
});

test("streaming disabled ignores partial and reasoning streams and only uses final text", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ replyOptions, dispatcherOptions }) => {
    assert.equal(typeof replyOptions.onPartialReply, "function");
    assert.equal(typeof replyOptions.onReasoningStream, "function");
    replyOptions.onPartialReply("ignored partial");
    replyOptions.onReasoningStream("ignored reasoning");
    await dispatcherOptions.deliver({ text: "final only when streaming disabled" }, { kind: "final" });
  });
  const { bridge, connection } = createBridge({
    runtime,
    config: {
      channels: {
        "message-bridge": {
          streaming: false,
        },
      },
    },
  });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_streaming_off_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_streaming_off_1",
      text: "hello",
    },
  });

  const toolEvents = getToolEvents(connection);
  assert.equal(findAssistantTextUpdateIndex(toolEvents, "ignored partial"), -1);
  assert.equal(
    toolEvents.filter((message) => message.event.properties?.part?.type === "reasoning").length,
    0,
  );
  assert.notEqual(findAssistantTextUpdateIndex(toolEvents, "final only when streaming disabled"), -1);
});

test("streaming disabled does not reuse hidden partial text when final is empty", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ replyOptions, dispatcherOptions }) => {
    assert.equal(typeof replyOptions.onPartialReply, "function");
    replyOptions.onPartialReply("hidden partial");
    await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
  });
  const { bridge, connection, logger } = createBridge({
    runtime,
    config: {
      channels: {
        "message-bridge": {
          streaming: false,
        },
      },
    },
  });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_streaming_off_empty_final_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_streaming_off_empty_final_1",
      text: "hello",
    },
  });

  const messages = connection.sent.map(({ message }) => message);
  assert.equal(messages.some((message) => message.type === "tool_done"), false);
  assert.equal(
    messages.some((message) => message.type === "tool_event" && message.event.properties?.part?.text === "hidden partial"),
    false,
  );
  assert.ok(messages.some((message) => message.type === "tool_event" && message.event.type === "session.error"));
  assert.ok(messages.some((message) => message.type === "tool_error" && message.error === "assistant_response_missing_text"));
  assert.equal(logger.records.info.some((entry) => entry.message === "bridge.chat.completed"), false);
});

test("runtime reply final-only reuses the same assistant text part identity", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "identity final" }, { kind: "final" });
  });
  const { bridge, connection } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_identity_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_identity_1",
      text: "hello",
    },
  });

  const toolEvents = getToolEvents(connection);
  const identityUpdateIndex = findAssistantTextUpdateIndex(toolEvents, "identity final");
  assert.notEqual(identityUpdateIndex, -1);
  assertSameAssistantTextPart(toolEvents, identityUpdateIndex - 1, identityUpdateIndex);
});

test("missing reply runtime emits session.error and tool_error without assistant completion", async () => {
  const runtime = {
    channel: {
      routing: {
        resolveAgentRoute() {
          return {
            agentId: "agent_1",
            accountId: "default",
          };
        },
      },
    },
  };
  const { bridge, connection } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_missing_reply_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_missing_reply_1",
      text: "hello",
    },
  });

  const messages = connection.sent.map(({ message }) => message);
  assert.ok(messages.some((message) => message.type === "tool_event" && message.event.type === "session.error"));
  assert.ok(messages.some((message) => message.type === "tool_error" && message.error === "missing_reply_runtime"));
  assert.equal(messages.some((message) => message.type === "tool_done"), false);
  assert.equal(
    messages.some((message) => message.type === "tool_event" && message.event.properties?.info?.role === "assistant"),
    false,
  );
});

test("missing route resolver emits session.error and tool_error without assistant completion", async () => {
  const runtime = {
    channel: {
      reply: {
        resolveEnvelopeFormatOptions() {
          return {};
        },
        formatAgentEnvelope({ body }) {
          return body;
        },
        finalizeInboundContext(context) {
          return context;
        },
        async dispatchReplyWithBufferedBlockDispatcher() {},
      },
    },
  };
  const { bridge, connection } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_missing_route_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_missing_route_1",
      text: "hello",
    },
  });

  const messages = connection.sent.map(({ message }) => message);
  assert.ok(messages.some((message) => message.type === "tool_event" && message.event.type === "session.error"));
  assert.ok(messages.some((message) => message.type === "tool_error" && message.error === "missing_route_resolver"));
  assert.equal(messages.some((message) => message.type === "tool_done"), false);
  assert.equal(
    messages.some((message) => message.type === "tool_event" && message.event.properties?.info?.role === "assistant"),
    false,
  );
});

test("empty final without partial fails instead of emitting an assistant reply", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
  });
  const { bridge, connection, logger } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_empty_final_2",
    action: "chat",
    payload: {
      toolSessionId: "ses_empty_final_2",
      text: "hello",
    },
  });

  const messages = connection.sent.map(({ message }) => message);
  assert.ok(messages.some((message) => message.type === "tool_event" && message.event.type === "session.error"));
  assert.ok(messages.some((message) => message.type === "tool_error" && message.error === "assistant_response_missing_text"));
  assert.equal(messages.some((message) => message.type === "tool_done"), false);
  assert.equal(
    messages.some((message) => message.type === "tool_event" && message.event.properties?.info?.role === "assistant"),
    false,
  );
  assert.equal(logger.records.info.some((entry) => entry.message === "bridge.chat.completed"), false);
});

test("runtime tool agent events project to message.part.updated tool states", async () => {
  let bridgeRef;
  const runtime = createRuntimeReplyRuntime(async ({ ctx, dispatcherOptions }) => {
    bridgeRef.handleRuntimeAgentEvent({
      stream: "tool",
      sessionKey: ctx.SessionKey,
      data: {
        phase: "start",
        toolCallId: "call_1",
        name: "search",
      },
    });
    bridgeRef.handleRuntimeAgentEvent({
      stream: "tool",
      sessionKey: ctx.SessionKey,
      data: {
        phase: "result",
        toolCallId: "call_1",
        name: "search",
      },
    });
    await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
    bridgeRef.handleRuntimeAgentEvent({
      stream: "tool",
      sessionKey: ctx.SessionKey,
      data: {
        phase: "result",
        toolCallId: "call_2",
        name: "search",
        isError: true,
      },
    });
    await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
  });
  const created = createBridge({ runtime });
  bridgeRef = created.bridge;

  await created.bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_4",
    action: "chat",
    payload: {
      toolSessionId: "ses_tool_4",
      text: "hello",
    },
  });

  const toolEvents = created.connection.sent
    .map(({ message }) => message)
    .filter((message) => message.type === "tool_event" && message.event.type === "message.part.updated" && message.event.properties.part.type === "tool");

  assert.deepEqual(
    toolEvents.map((message) => ({
      status: message.event.properties.part.state.status,
      output: message.event.properties.part.state.output,
      error: message.event.properties.part.state.error,
    })),
    [
      {
        status: "running",
        output: undefined,
        error: undefined,
      },
      {
        status: "completed",
        output: undefined,
        error: undefined,
      },
      {
        status: "completed",
        output: "tool output",
        error: undefined,
      },
      {
        status: "error",
        output: undefined,
        error: "tool_search_failed",
      },
    ],
  );

  for (const message of toolEvents) {
    assert.equal(typeof message.event.properties.time, "number");
  }
});

test("runtime tool result can project output and error directly from agent event payload", async () => {
  let bridgeRef;
  const runtime = createRuntimeReplyRuntime(async ({ ctx, dispatcherOptions }) => {
    bridgeRef.handleRuntimeAgentEvent({
      stream: "tool",
      sessionKey: ctx.SessionKey,
      data: {
        phase: "result",
        toolCallId: "call_payload_1",
        name: "search",
        output: "payload tool output",
      },
    });
    bridgeRef.handleRuntimeAgentEvent({
      stream: "tool",
      sessionKey: ctx.SessionKey,
      data: {
        phase: "result",
        toolCallId: "call_payload_2",
        name: "search",
        isError: true,
        error: "payload tool error",
      },
    });
    await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
  });
  const created = createBridge({ runtime });
  bridgeRef = created.bridge;

  await created.bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_4b",
    action: "chat",
    payload: {
      toolSessionId: "ses_tool_4b",
      text: "hello",
    },
  });

  const toolEvents = created.connection.sent
    .map(({ message }) => message)
    .filter((message) => message.type === "tool_event" && message.event.type === "message.part.updated" && message.event.properties.part.type === "tool");

  assert.deepEqual(
    toolEvents.map((message) => ({
      status: message.event.properties.part.state.status,
      output: message.event.properties.part.state.output,
      error: message.event.properties.part.state.error,
    })),
    [
      {
        status: "completed",
        output: "payload tool output",
        error: undefined,
      },
      {
        status: "error",
        output: undefined,
        error: "payload tool error",
      },
    ],
  );
});

test("tool payload blocks are consumed once and do not leak to a stale pending target", async () => {
  let bridgeRef;
  const runtime = createRuntimeReplyRuntime(async ({ ctx, dispatcherOptions }) => {
    bridgeRef.handleRuntimeAgentEvent({
      stream: "tool",
      sessionKey: ctx.SessionKey,
      data: {
        phase: "result",
        toolCallId: "call_payload_once",
        name: "search",
      },
    });
    await dispatcherOptions.deliver({ text: "tool output once" }, { kind: "tool" });
    await dispatcherOptions.deliver({ text: "tool output should not leak" }, { kind: "tool" });
    await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
  });
  const created = createBridge({ runtime });
  bridgeRef = created.bridge;

  await created.bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_tool_once",
    action: "chat",
    payload: {
      toolSessionId: "ses_tool_once",
      text: "hello",
    },
  });

  const toolEvents = created.connection.sent
    .map(({ message }) => message)
    .filter((message) => message.type === "tool_event" && message.event.type === "message.part.updated" && message.event.properties.part.type === "tool");

  assert.deepEqual(
    toolEvents.map((message) => ({
      status: message.event.properties.part.state.status,
      output: message.event.properties.part.state.output,
    })),
    [
      {
        status: "completed",
        output: undefined,
      },
      {
        status: "completed",
        output: "tool output once",
      },
    ],
  );
});

test("runtime reply reasoning stream only updates reasoning part and can arrive before text", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ replyOptions, dispatcherOptions }) => {
    assert.equal(typeof replyOptions.onReasoningStream, "function");
    assert.equal(typeof replyOptions.onPartialReply, "function");
    replyOptions.onReasoningStream("first thought");
    replyOptions.onPartialReply("done");
    await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
  });
  const created = createBridge({ runtime });

  await created.bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_reason_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_reason_1",
      text: "hello",
    },
  });

  const reasoningEvents = created.connection.sent
    .map(({ message }) => message)
    .filter((message) => message.type === "tool_event" && message.event.type === "message.part.updated" && message.event.properties.part.type === "reasoning");

  assert.equal(reasoningEvents.length, 1);
  assert.equal(reasoningEvents[0].event.properties.part.text, "");
  assert.equal(typeof reasoningEvents[0].event.properties.time, "number");

  const reasoningDelta = created.connection.sent
    .map(({ message }) => message)
    .find((message) => message.type === "tool_event" && message.event.type === "message.part.delta" && message.event.properties.delta === "first thought");

  assert.ok(reasoningDelta);
  assert.equal(findAssistantTextUpdateIndex(getToolEvents(created.connection), "first thought"), -1);
});

test("start subscribes runtime agent events and stop unsubscribes them", async () => {
  const runtimeBus = createRuntimeEventBus();
  const runtime = createRuntimeReplyRuntime(async ({ ctx, dispatcherOptions }) => {
    runtimeBus.emit({
      stream: "tool",
      sessionKey: ctx.SessionKey,
      data: {
        phase: "result",
        toolCallId: "call_subscribed_1",
        name: "search",
        output: "subscribed tool output",
      },
    });
    await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
  });
  runtime.events = runtimeBus.runtimeEvents;
  const { bridge, connection } = createBridge({ runtime });

  await bridge.start();

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_subscribe_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_subscribe_1",
      text: "hello",
    },
  });

  const beforeStopCount = connection.sent.length;
  assert.ok(connection.sent.some(({ message }) => message.event?.properties?.part?.type === "tool"));

  await bridge.stop();

  runtimeBus.emit({
    stream: "tool",
    sessionKey: "message-bridge:default:ses_subscribe_1",
    data: {
      phase: "result",
      toolCallId: "call_subscribed_2",
      name: "search",
      output: "should not appear after stop",
    },
  });

  assert.equal(connection.sent.length, beforeStopCount);
});

test("bridge ignores downstream messages when connection is unavailable", async () => {
  const connection = new FakeGatewayConnection();
  connection.state = "DISCONNECTED";
  const { bridge } = createBridge({ connection });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_5",
    action: "chat",
    payload: {
      toolSessionId: "ses_tool_5",
      text: "hello",
    },
  });

  assert.deepEqual(connection.sent, []);
});

test("bridge ignores downstream messages before gateway reaches READY", async () => {
  const connection = new FakeGatewayConnection();
  connection.state = "CONNECTED";
  const { bridge } = createBridge({ connection });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_6",
    action: "chat",
    payload: {
      toolSessionId: "ses_tool_6",
      text: "hello",
    },
  });

  assert.deepEqual(connection.sent, []);
});
