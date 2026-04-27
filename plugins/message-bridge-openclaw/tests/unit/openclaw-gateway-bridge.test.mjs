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
        async dispatchReplyFromConfig(args) {
          await dispatchImpl(args);
        },
      },
    },
  };
}

function createRuntimeReplyDispatchHarness(dispatcher) {
  return {
    block(payload) {
      return typeof dispatcher.sendBlockReply === "function"
        ? dispatcher.sendBlockReply(payload)
        : dispatcher.deliver(payload, { kind: "block" });
    },
    final(payload) {
      return typeof dispatcher.sendFinalReply === "function"
        ? dispatcher.sendFinalReply(payload)
        : dispatcher.deliver(payload, { kind: "final" });
    },
    tool(payload) {
      return typeof dispatcher.sendToolResult === "function"
        ? dispatcher.sendToolResult(payload)
        : dispatcher.deliver(payload, { kind: "tool" });
    },
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createRuntimeEventBus() {
  const agentListeners = new Set();
  const gatewayListeners = new Set();
  return {
    events: {
      onAgentEvent(listener) {
        agentListeners.add(listener);
        return () => agentListeners.delete(listener);
      },
      onGatewayEvent(listener) {
        gatewayListeners.add(listener);
        return () => gatewayListeners.delete(listener);
      },
    },
    runtimeEvents: {
      onAgentEvent(listener) {
        agentListeners.add(listener);
        return () => agentListeners.delete(listener);
      },
    },
    emit(event) {
      for (const listener of agentListeners) {
        listener(event);
      }
    },
    emitAgent(event) {
      for (const listener of agentListeners) {
        listener(event);
      }
    },
    emitGateway(event) {
      for (const listener of gatewayListeners) {
        listener(event);
      }
    },
  };
}

function createBridge({ runtime, connection = new FakeGatewayConnection(), setStatus = () => {}, config = {} } = {}) {
  const bridge = new OpenClawGatewayBridge({
    account: createAccount(),
    config,
    logger: createLogger(),
    runtime: runtime ?? createFallbackRuntime(),
    setStatus,
    connectionFactory: () => connection,
  });

  return { bridge, connection };
}

function getToolEvents(connection) {
  return connection.sent
    .map(({ message }) => message)
    .filter((message) => message.type === "tool_event");
}

function assertAdjacentAssistantTextDelta(events, updatedIndex, expectedText, expectedDelta = "") {
  const updatedEvent = events[updatedIndex]?.event;
  assert.ok(updatedEvent);
  assert.equal(updatedEvent.type, "message.part.updated");
  assert.equal(updatedEvent.properties?.part?.type, "text");
  assert.equal(updatedEvent.properties?.part?.text, expectedText);

  const deltaEvent = events[updatedIndex - 1]?.event;
  assert.ok(deltaEvent);
  assert.equal(deltaEvent.type, "message.part.delta");
  assert.equal(deltaEvent.properties?.delta, expectedDelta);
  assert.equal(deltaEvent.properties?.messageID, updatedEvent.properties?.part?.messageID);
  assert.equal(deltaEvent.properties?.partID, updatedEvent.properties?.part?.id);
}

function assertNoAdjacentAssistantTextDelta(events, updatedIndex, expectedText) {
  const updatedEvent = events[updatedIndex]?.event;
  assert.ok(updatedEvent);
  assert.equal(updatedEvent.type, "message.part.updated");
  assert.equal(updatedEvent.properties?.part?.type, "text");
  assert.equal(updatedEvent.properties?.part?.text, expectedText);

  const previousEvent = events[updatedIndex - 1]?.event;
  assert.ok(previousEvent);
  assert.notEqual(previousEvent.type, "message.part.delta");
}

function assertAssistantTextSeed(events, updatedIndex) {
  const updatedEvent = events[updatedIndex]?.event;
  assert.ok(updatedEvent);

  const previousEvent = events[updatedIndex - 1]?.event;
  const fallbackEvent = events[updatedIndex - 2]?.event;
  const seedEvent =
    previousEvent?.type === "message.part.updated" && previousEvent.properties?.part?.text === ""
      ? previousEvent
      : fallbackEvent;
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

function findAssistantTextSeedIndex(events, updatedIndex) {
  for (let index = Math.max(0, updatedIndex - 3); index < updatedIndex; index += 1) {
    const event = events[index]?.event;
    if (
      event?.type === "message.part.updated"
      && event.properties?.part?.type === "text"
      && event.properties?.part?.text === ""
    ) {
      return index;
    }
  }
  return -1;
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

test("start publishes streaming capability snapshot when runtime reply is unavailable", async () => {
  const statuses = [];
  const { bridge } = createBridge({
    runtime: createFallbackRuntime(),
    setStatus(status) {
      statuses.push(status);
    },
  });

  await bridge.start();
  await bridge.stop();

  assert.ok(statuses.some((status) => status.streamingPathReason === "missing_route_resolver"));
  assert.ok(statuses.some((status) => status.streamingPathHealthy === false));
});

test("approval requested gateway event is projected as permission.asked", async () => {
  const bus = createRuntimeEventBus();
  const runtime = {
    events: bus.events,
    gatewayClient: {
      async request() {},
    },
  };
  const { bridge, connection } = createBridge({ runtime });

  await bridge.start();
  bus.emitGateway({
    event: "exec.approval.requested",
    payload: {
      id: "perm_1",
      toolSessionId: "ses_tool_perm_1",
      title: "Run command",
      metadata: {
        command: "ls",
      },
    },
  });

  const asked = connection.sent.find(({ message }) => {
    return message.type === "tool_event" && message.event.type === "permission.asked";
  });

  assert.ok(asked);
  assert.equal(asked.message.event.properties.id, "perm_1");
  assert.equal(asked.message.event.properties.sessionID, "ses_tool_perm_1");
});

test("permission_reply resolves through exec.approval.resolve after requested event", async () => {
  const requests = [];
  const bus = createRuntimeEventBus();
  const runtime = {
    events: bus.events,
    gatewayClient: {
      async request(method, params) {
        requests.push({ method, params });
      },
    },
  };
  const { bridge, connection } = createBridge({ runtime });

  await bridge.start();
  bus.emitGateway({
    event: "exec.approval.requested",
    payload: {
      id: "perm_2",
      toolSessionId: "ses_tool_perm_2",
    },
  });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_perm_2",
    action: "permission_reply",
    payload: {
      toolSessionId: "ses_tool_perm_2",
      permissionId: "perm_2",
      response: "always",
    },
  });

  assert.deepEqual(requests, [
    {
      method: "exec.approval.resolve",
      params: {
        id: "perm_2",
        decision: "allow-always",
      },
    },
  ]);
  assert.equal(connection.sent.some(({ message }) => message.type === "tool_error"), false);
});

test("question.asked event is projected and question_reply uses host adapter when available", async () => {
  const replies = [];
  const bus = createRuntimeEventBus();
  const runtime = {
    events: bus.events,
    question: {
      async reply(params) {
        replies.push(params);
      },
    },
  };
  const { bridge, connection } = createBridge({ runtime });

  await bridge.start();
  bus.emitGateway({
    event: "question.asked",
    payload: {
      id: "q_req_1",
      toolSessionId: "ses_tool_q_1",
      tool: {
        callID: "call_q_1",
      },
      questions: [
        {
          question: "Choose a framework",
          header: "Framework",
          options: [{ label: "Vite" }],
        },
      ],
    },
  });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_q_1",
    action: "question_reply",
    payload: {
      toolSessionId: "ses_tool_q_1",
      toolCallId: "call_q_1",
      answer: "Vite",
    },
  });

  const asked = connection.sent.find(({ message }) => {
    return message.type === "tool_event" && message.event.type === "question.asked";
  });

  assert.ok(asked);
  assert.deepEqual(replies, [
    {
      requestId: "q_req_1",
      answer: "Vite",
    },
  ]);
});

test("question_reply returns stable host-unavailable error when no host adapter exists", async () => {
  const bus = createRuntimeEventBus();
  const runtime = {
    events: bus.events,
  };
  const { bridge, connection } = createBridge({ runtime });

  await bridge.start();
  bus.emitGateway({
    event: "question.asked",
    payload: {
      id: "q_req_2",
      toolSessionId: "ses_tool_q_2",
      questions: [
        {
          question: "Choose a framework",
        },
      ],
    },
  });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_q_2",
    action: "question_reply",
    payload: {
      toolSessionId: "ses_tool_q_2",
      answer: "Vite",
    },
  });

  const toolError = connection.sent.findLast?.(({ message }) => message.type === "tool_error")
    ?? [...connection.sent].reverse().find(({ message }) => message.type === "tool_error");

  assert.ok(toolError);
  assert.equal(toolError.message.error, "question_reply_unavailable_in_host");
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
  const runtime = createRuntimeReplyRuntime(async ({ dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
    await reply.block({ text: "hello" });
    await reply.block({ text: " world" });
    await reply.final({ text: "hello world" });
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
      text: "",
      delta: "",
    },
    {
      type: "tool_event",
      eventType: "message.part.delta",
      role: undefined,
      partType: undefined,
      text: undefined,
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

  const toolEvents = getToolEvents(connection);
  const assistantMessageUpdatedIndex = toolEvents.findIndex((message) => {
    return message.event.type === "message.updated" && message.event.properties?.info?.role === "assistant";
  });
  const finalAssistantTextUpdateIndex = findAssistantTextUpdateIndex(toolEvents, "hello world", assistantMessageUpdatedIndex);
  assert.notEqual(finalAssistantTextUpdateIndex, -1);
  const streamedDeltaEvent = toolEvents.find((message) => {
    return message.event.type === "message.part.delta" && message.event.properties?.delta === " world";
  });
  assert.ok(streamedDeltaEvent);
  assert.equal(streamedDeltaEvent.event.properties.field, "text");
  assertAdjacentAssistantTextDelta(toolEvents, finalAssistantTextUpdateIndex, "hello world", " world");

  const updatedPartEvents = connection.sent
    .map(({ message }) => message)
    .filter((message) => message.type === "tool_event" && message.event.type === "message.part.updated");

  for (const message of updatedPartEvents) {
    assert.equal(typeof message.event.properties.time, "number");
  }
});

test("single block stream emits one final text update after streaming delta", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
    await reply.block({ text: "hello" });
    await reply.final({ text: "hello" });
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
  assertAdjacentAssistantTextDelta(toolEvents, assistantTextUpdateIndexes[0], "hello", "hello");
});

test("runtime reply final reconciliation extends streamed prefix without duplicating text", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
    await reply.block({ text: "hello" });
    await reply.final({ text: "hello world" });
  });
  const { bridge, connection } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_reconcile_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_reconcile_1",
      text: "hello",
    },
  });

  const toolEvents = getToolEvents(connection);
  const helloIndex = findAssistantTextUpdateIndex(toolEvents, "hello");
  const finalIndex = findAssistantTextUpdateIndex(toolEvents, "hello world", helloIndex + 1);

  assert.notEqual(helloIndex, -1);
  assert.notEqual(finalIndex, -1);

  const finalUpdates = toolEvents.filter((message) => {
    return message.event.type === "message.part.updated"
      && message.event.properties?.part?.type === "text"
      && message.event.properties?.part?.text === "hello world";
  });
  assert.equal(finalUpdates.length, 1);
  const suffixDeltaEvent = toolEvents.find((message) => {
    return message.event.type === "message.part.delta" && message.event.properties?.delta === " world";
  });
  assert.equal(suffixDeltaEvent, undefined);
});

test("runtime reply final-only replays synthetic delta and still marks status unhealthy", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
    await reply.final({ text: "hello only final" });
  });
  const statuses = [];
  const { bridge, connection } = createBridge({
    runtime,
    setStatus(status) {
      statuses.push(status);
    },
  });

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
  assertAdjacentAssistantTextDelta(toolEvents, finalAssistantTextUpdateIndex, "hello only final", "hello only final");
  assert.ok(statuses.some((status) => status.streamingPathReason === "runtime_reply_final_only"));
  assert.ok(statuses.some((status) => status.streamingPathHealthy === false));
});

test("runtime reply final-only replays synthetic delta with visible pacing", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
    await reply.final({ text: "abcdefghijkl" });
  });
  const { bridge, connection } = createBridge({
    runtime,
    config: {
      agents: {
        defaults: {
          blockStreamingChunk: {
            minChars: 4,
            maxChars: 4,
          },
          blockStreamingCoalesce: {
            idleMs: 20,
          },
        },
      },
    },
  });

  const pending = bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_final_only_paced_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_final_only_paced_1",
      text: "hello",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));

  const midEvents = getToolEvents(connection);
  const midDeltaCount = midEvents.filter((message) => {
    return message.event.type === "message.part.delta";
  }).length;
  const midFinalIndex = findAssistantTextUpdateIndex(midEvents, "abcdefghijkl");

  assert.ok(midDeltaCount >= 1);
  assert.equal(midFinalIndex, -1);

  await pending;

  const finalEvents = getToolEvents(connection);
  const finalDeltaCount = finalEvents.filter((message) => {
    return message.event.type === "message.part.delta";
  }).length;
  const finalTextIndex = findAssistantTextUpdateIndex(finalEvents, "abcdefghijkl");

  assert.equal(finalDeltaCount, 3);
  assert.notEqual(finalTextIndex, -1);
});

test("runtime reply waits for dispatcher idle before emitting session.idle and tool_done", async () => {
  const idleGate = createDeferred();
  const runtime = createRuntimeReplyRuntime(async ({ dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
    assert.deepEqual(dispatcher.getQueuedCounts(), { tool: 0, block: 0, final: 0 });
    const pendingBlock = reply.block({ text: "hello" });
    assert.equal(typeof pendingBlock, "boolean");
    assert.deepEqual(dispatcher.getQueuedCounts(), { tool: 0, block: 1, final: 0 });
    await idleGate.promise;
    await pendingBlock;
    await reply.final({ text: "hello" });
    assert.deepEqual(dispatcher.getQueuedCounts(), { tool: 0, block: 1, final: 1 });
  });
  const { bridge, connection } = createBridge({ runtime });

  const pending = bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_idle_gate_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_idle_gate_1",
      text: "hello",
    },
  });

  await Promise.resolve();
  assert.equal(connection.sent.some(({ message }) => message.event?.type === "session.idle"), false);
  assert.equal(connection.sent.some(({ message }) => message.type === "tool_done"), false);

  idleGate.resolve();
  await pending;

  const eventTypes = connection.sent.map(({ message }) => {
    return message.type === "tool_done" ? "tool_done" : message.event.type;
  });
  const finalTextIndex = eventTypes.findIndex((eventType, index) => {
    return eventType === "message.part.updated"
      && connection.sent[index].message.event.properties?.part?.text === "hello";
  });
  const idleIndex = eventTypes.lastIndexOf("session.idle");
  const doneIndex = eventTypes.lastIndexOf("tool_done");

  assert.ok(finalTextIndex >= 0);
  assert.ok(idleIndex > finalTextIndex);
  assert.ok(doneIndex > idleIndex);
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
      text: "",
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

  const toolEvents = getToolEvents(connection);
  const fallbackUpdateIndex = findAssistantTextUpdateIndex(toolEvents, "fallback answer");
  assert.notEqual(fallbackUpdateIndex, -1);
  assertAssistantTextSeed(toolEvents, fallbackUpdateIndex);
  assertNoAdjacentAssistantTextDelta(toolEvents, fallbackUpdateIndex, "fallback answer");
});

test("subagent fallback emits empty response without synthetic delta before final text update", async () => {
  const runtime = createFallbackRuntime({
    subagent: {
      async run() {
        return { runId: "run_empty" };
      },
      async waitForRun() {
        return { status: "ok" };
      },
      async getSessionMessages() {
        return {
          messages: [
            {
              role: "assistant",
              content: "",
            },
          ],
        };
      },
      async deleteSession() {},
    },
  });
  const { bridge, connection } = createBridge({ runtime });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_empty_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_tool_empty_1",
      text: "hello",
    },
  });

  const toolEvents = getToolEvents(connection);
  const emptyUpdateIndex = findAssistantTextUpdateIndex(toolEvents, "(empty response)");

  assert.notEqual(emptyUpdateIndex, -1);
  assertAssistantTextSeed(toolEvents, emptyUpdateIndex);
  assertNoAdjacentAssistantTextDelta(toolEvents, emptyUpdateIndex, "(empty response)");
});

test("runtime reply final-only and fallback reuse the same assistant text part identity", async () => {
  const runtime = createRuntimeReplyRuntime(async ({ dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
    await reply.final({ text: "identity final" });
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
  const deltaEvent = toolEvents[identityUpdateIndex - 1]?.event;
  assert.ok(deltaEvent);
  assert.equal(deltaEvent.type, "message.part.delta");
  assert.equal(deltaEvent.properties?.messageID, toolEvents[identityUpdateIndex].event.properties?.part?.messageID);
  assert.equal(deltaEvent.properties?.partID, toolEvents[identityUpdateIndex].event.properties?.part?.id);
});

test("runtime tool agent events project to message.part.updated tool states", async () => {
  let bridgeRef;
  const runtime = createRuntimeReplyRuntime(async ({ ctx, dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
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
    await reply.tool({ text: "tool output" });
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
    await reply.block({ text: "done" });
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
  const runtime = createRuntimeReplyRuntime(async ({ ctx, dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
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
    await reply.block({ text: "done" });
    await reply.final({ text: "done" });
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
  const runtime = createRuntimeReplyRuntime(async ({ ctx, dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
    bridgeRef.handleRuntimeAgentEvent({
      stream: "tool",
      sessionKey: ctx.SessionKey,
      data: {
        phase: "result",
        toolCallId: "call_payload_once",
        name: "search",
      },
    });
    await reply.tool({ text: "tool output once" });
    await reply.tool({ text: "tool output should not leak" });
    await reply.block({ text: "done" });
    await reply.final({ text: "done" });
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
  const runtime = createRuntimeReplyRuntime(async ({ ctx, dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
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
    await reply.block({ text: "done" });
    await reply.final({ text: "done" });
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

test("abort_session suppresses late runtime reply blocks and does not emit extra final text", async () => {
  const releaseBlock = createDeferred();
  const runtime = createRuntimeReplyRuntime(async ({ dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
    await releaseBlock.promise;
    await reply.block({ text: "late block" });
    await reply.final({ text: "late block final" });
  });
  const { bridge, connection } = createBridge({ runtime });

  const pendingChat = bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_abort_1",
    action: "chat",
    payload: {
      toolSessionId: "ses_abort_1",
      text: "hello",
    },
  });

  await bridge.handleDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_abort_1",
    action: "abort_session",
    payload: {
      toolSessionId: "ses_abort_1",
    },
  });

  releaseBlock.resolve();
  await pendingChat;

  const finalTexts = connection.sent
    .map(({ message }) => message)
    .filter((message) => {
      return message.type === "tool_event"
        && message.event.type === "message.part.updated"
        && message.event.properties?.part?.type === "text";
    })
    .map((message) => message.event.properties.part.text);

  assert.deepEqual(finalTexts, ["hello"]);

  const toolDoneMessages = connection.sent
    .map(({ message }) => message)
    .filter((message) => message.type === "tool_done");
  assert.equal(toolDoneMessages.length, 1);
  assert.equal(toolDoneMessages[0].toolSessionId, "ses_abort_1");
  assert.equal(connection.sent.some(({ message }) => message.event?.type === "session.idle"), false);
});

test("start subscribes runtime agent events and stop unsubscribes them", async () => {
  const runtimeBus = createRuntimeEventBus();
  const runtime = createRuntimeReplyRuntime(async ({ ctx, dispatcher }) => {
    const reply = createRuntimeReplyDispatchHarness(dispatcher);
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
    await reply.block({ text: "done" });
    await reply.final({ text: "done" });
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
