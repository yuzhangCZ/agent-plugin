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
  return {
    info() {},
    warn() {},
    error() {},
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

function createFallbackRuntime(overrides = {}) {
  return {
    subagent: {
      async run() {
        return { runId: "run_1" };
      },
      async waitForRun() {
        return { status: "ok" };
      },
      async getSessionMessages() {
        return {
          messages: [
            {
              role: "assistant",
              content: "fallback answer",
            },
          ],
        };
      },
      async deleteSession() {},
    },
    ...overrides,
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

function createBridge({ runtime, connection = new FakeGatewayConnection() } = {}) {
  const bridge = new OpenClawGatewayBridge({
    account: createAccount(),
    config: {},
    logger: createLogger(),
    runtime: runtime ?? createFallbackRuntime(),
    setStatus() {},
    connectionFactory: () => connection,
  });

  return { bridge, connection };
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

test("subagent fallback emits session.idle with toolSessionId instead of internal sessionKey", async () => {
  const { bridge, connection } = createBridge();

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_tool_1",
      text: "hello",
    },
  });

  const idleMessage = connection.sent.find(({ message }) => {
    return message.type === "tool_event" && message.event?.type === "session.idle";
  });

  assert.ok(idleMessage);
  assert.equal(idleMessage.message.event.properties.sessionID, "ses_tool_1");
});

test("runtime reply chat emits assistant text events in protocol order", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "hello" }, { kind: "block" });
    await dispatcherOptions.deliver({ text: " world" }, { kind: "block" });
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

  const actual = connection.sent.map(({ message }) => {
    if (message.type === "tool_done") {
      return {
        type: "tool_done",
      };
    }

    return {
      type: message.type,
      eventType: message.event.type,
      role: message.event.properties?.info?.role,
      partType: message.event.properties?.part?.type,
      text: message.event.properties?.part?.text,
      delta: message.event.properties?.delta ?? message.event.properties?.delta,
    };
  });

  assert.deepEqual(actual, [
    {
      type: "tool_event",
      eventType: "message.updated",
      role: "user",
      partType: undefined,
      text: undefined,
      delta: undefined,
    },
    {
      type: "tool_event",
      eventType: "message.part.updated",
      role: undefined,
      partType: "text",
      text: "hello",
      delta: undefined,
    },
    {
      type: "tool_event",
      eventType: "session.updated",
      role: undefined,
      partType: undefined,
      text: undefined,
      delta: undefined,
    },
    {
      type: "tool_event",
      eventType: "session.status",
      role: undefined,
      partType: undefined,
      text: undefined,
      delta: undefined,
    },
    {
      type: "tool_event",
      eventType: "message.updated",
      role: "assistant",
      partType: undefined,
      text: undefined,
      delta: undefined,
    },
    {
      type: "tool_event",
      eventType: "message.part.updated",
      role: undefined,
      partType: "step-start",
      text: undefined,
      delta: undefined,
    },
    {
      type: "tool_event",
      eventType: "message.part.updated",
      role: undefined,
      partType: "text",
      text: "hello",
      delta: "hello",
    },
    {
      type: "tool_event",
      eventType: "message.part.delta",
      role: undefined,
      partType: undefined,
      text: undefined,
      delta: " world",
    },
    {
      type: "tool_event",
      eventType: "message.part.updated",
      role: undefined,
      partType: "text",
      text: "hello world",
      delta: undefined,
    },
    {
      type: "tool_event",
      eventType: "message.part.updated",
      role: undefined,
      partType: "step-finish",
      text: undefined,
      delta: undefined,
    },
    {
      type: "tool_event",
      eventType: "message.updated",
      role: "assistant",
      partType: undefined,
      text: undefined,
      delta: undefined,
    },
    {
      type: "tool_event",
      eventType: "session.updated",
      role: undefined,
      partType: undefined,
      text: undefined,
      delta: undefined,
    },
    {
      type: "tool_event",
      eventType: "session.idle",
      role: undefined,
      partType: undefined,
      text: undefined,
      delta: undefined,
    },
    {
      type: "tool_done",
    },
  ]);

  const deltaEvent = connection.sent[7].message.event;
  assert.equal(deltaEvent.properties.delta, " world");
  assert.equal(deltaEvent.properties.field, "text");

  const updatedPartEvents = connection.sent
    .map(({ message }) => message)
    .filter((message) => message.type === "tool_event" && message.event.type === "message.part.updated");

  for (const message of updatedPartEvents) {
    assert.equal(typeof message.event.properties.time, "number");
  }
});

test("subagent fallback emits final assistant text before idle and tool_done", async () => {
  const { bridge, connection } = createBridge();

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_3",
    action: "chat",
    payload: {
      toolSessionId: "ses_tool_3",
      text: "hello",
    },
  });

  const actual = connection.sent.map(({ message }) => {
    if (message.type === "tool_done") {
      return { type: "tool_done" };
    }

    return {
      type: message.type,
      eventType: message.event.type,
      role: message.event.properties?.info?.role,
      partType: message.event.properties?.part?.type,
      text: message.event.properties?.part?.text,
    };
  });

  assert.deepEqual(actual, [
    {
      type: "tool_event",
      eventType: "message.updated",
      role: "user",
      partType: undefined,
      text: undefined,
    },
    {
      type: "tool_event",
      eventType: "message.part.updated",
      role: undefined,
      partType: "text",
      text: "hello",
    },
    {
      type: "tool_event",
      eventType: "session.updated",
      role: undefined,
      partType: undefined,
      text: undefined,
    },
    {
      type: "tool_event",
      eventType: "session.status",
      role: undefined,
      partType: undefined,
      text: undefined,
    },
    {
      type: "tool_event",
      eventType: "message.updated",
      role: "assistant",
      partType: undefined,
      text: undefined,
    },
    {
      type: "tool_event",
      eventType: "message.part.updated",
      role: undefined,
      partType: "step-start",
      text: undefined,
    },
    {
      type: "tool_event",
      eventType: "message.part.updated",
      role: undefined,
      partType: "text",
      text: "fallback answer",
    },
    {
      type: "tool_event",
      eventType: "message.part.updated",
      role: undefined,
      partType: "step-finish",
      text: undefined,
    },
    {
      type: "tool_event",
      eventType: "message.updated",
      role: "assistant",
      partType: undefined,
      text: undefined,
    },
    {
      type: "tool_event",
      eventType: "session.updated",
      role: undefined,
      partType: undefined,
      text: undefined,
    },
    {
      type: "tool_event",
      eventType: "session.idle",
      role: undefined,
      partType: undefined,
      text: undefined,
    },
    {
      type: "tool_done",
    },
  ]);
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
    await dispatcherOptions.deliver({ text: "done" }, { kind: "block" });
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
    await dispatcherOptions.deliver({ text: "done" }, { kind: "block" });
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
    await dispatcherOptions.deliver({ text: "done" }, { kind: "block" });
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

test("runtime reasoning events project to reasoning part before assistant text", async () => {
  let bridgeRef;
  const runtime = createRuntimeReplyRuntime(async ({ ctx, dispatcherOptions }) => {
    bridgeRef.handleRuntimeAgentEvent({
      stream: "reasoning",
      sessionKey: ctx.SessionKey,
      data: {
        phase: "delta",
        text: "first thought",
        metadata: {
          signature: "sig_1",
        },
      },
    });
    bridgeRef.handleRuntimeAgentEvent({
      stream: "reasoning",
      sessionKey: ctx.SessionKey,
      data: {
        phase: "finish",
        text: "first thought",
        metadata: {
          signature: "sig_1",
        },
      },
    });
    await dispatcherOptions.deliver({ text: "done" }, { kind: "block" });
    await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
  });
  const created = createBridge({ runtime });
  bridgeRef = created.bridge;

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

  assert.equal(reasoningEvents.length, 2);
  assert.equal(reasoningEvents[0].event.properties.part.text, "");
  assert.equal(reasoningEvents[1].event.properties.part.text, "first thought");
  assert.equal(reasoningEvents[0].event.properties.part.metadata.signature, "sig_1");
  assert.equal(reasoningEvents[1].event.properties.part.metadata.signature, "sig_1");
  assert.equal(typeof reasoningEvents[0].event.properties.time, "number");
  assert.equal(typeof reasoningEvents[1].event.properties.time, "number");

  const reasoningDelta = created.connection.sent
    .map(({ message }) => message)
    .find((message) => message.type === "tool_event" && message.event.type === "message.part.delta" && message.event.properties.delta === "first thought");

  assert.ok(reasoningDelta);
});

test("start subscribes runtime agent events and stop unsubscribes them", async () => {
  const runtimeBus = createRuntimeEventBus();
  const runtime = createRuntimeReplyRuntime(async ({ ctx, dispatcherOptions }) => {
    runtimeBus.emit({
      stream: "reasoning",
      sessionKey: ctx.SessionKey,
      data: {
        phase: "finish",
        text: "subscribed reasoning",
      },
    });
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
    await dispatcherOptions.deliver({ text: "done" }, { kind: "block" });
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
  assert.ok(connection.sent.some(({ message }) => message.event?.properties?.part?.type === "reasoning"));
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
