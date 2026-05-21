import test from "node:test";
import assert from "node:assert/strict";

import { OpenClawProviderAdapter } from "../../src/sdk/OpenClawProviderAdapter.ts";
import { SessionRegistry } from "../../src/session/SessionRegistry.ts";

function createLogger(overrides = {}) {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
    ...overrides,
  };
}

function createAdapter(overrides = {}) {
  const sessionRegistry = overrides.sessionRegistry ?? new SessionRegistry("agent:acct");
  return new OpenClawProviderAdapter({
    account: {
      accountId: "acct",
      agentIdPrefix: "agent",
      runTimeoutMs: 1000,
    },
    config: {},
    runtime: {},
    logger: createLogger(),
    sessionRegistry,
    getSubagentRuntime: () => null,
    isOnline: () => true,
    ...overrides,
  });
}

function flushEvents() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

test("provider adapter fallback emits ordered facts and completed result", async () => {
  const provider = createAdapter({
    getSubagentRuntime: () => ({
      async run() {
        return { runId: "sub-1" };
      },
      async waitForRun() {
        return { status: "ok" };
      },
      async getSessionMessages() {
        return {
          messages: [
            {
              role: "assistant",
              content: "hello from subagent",
            },
          ],
        };
      },
    }),
  });

  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "run-1",
    toolSessionId: "tool-1",
    text: "hi",
  });

  const facts = [];
  for await (const fact of run.facts) {
    facts.push(fact);
  }

  assert.deepEqual(
    facts.map((fact) => fact.type),
    ["message.start", "text.done", "message.done"],
  );
  assert.equal(facts[1].content, "hello from subagent");
  await assert.doesNotReject(run.result());
  assert.deepEqual(await run.result(), { outcome: "completed" });
});

test("provider adapter abort closes active run and suppresses late runtime reply chunks", async () => {
  const calls = [];
  let capturedDispatcherOptions;
  const provider = createAdapter({
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute() {
            return { accountId: "acct", agentId: "agent" };
          },
        },
        reply: {
          async abortRun(input) {
            calls.push({ kind: "abort", ...input });
          },
          resolveEnvelopeFormatOptions() {
            return {};
          },
          formatAgentEnvelope({ body }) {
            return body;
          },
          finalizeInboundContext(input) {
            return input;
          },
          async dispatchReplyWithBufferedBlockDispatcher({ dispatcherOptions, replyOptions }) {
            capturedDispatcherOptions = dispatcherOptions;
            replyOptions.onAgentRunStart("host-run-1");
            await new Promise(() => {});
          },
        },
      },
    },
  });

  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "sdk-run-1",
    toolSessionId: "ses_abort_active_1",
    text: "hi",
  });
  await flushEvents();

  const result = await provider.abortSession({
    traceId: "trace-2",
    toolSessionId: "ses_abort_active_1",
    runId: "sdk-run-1",
  });
  await capturedDispatcherOptions.deliver({ text: "late chunk" }, { kind: "block" });

  const facts = [];
  for await (const fact of run.facts) {
    facts.push(fact);
  }

  assert.deepEqual(result, { applied: true });
  assert.deepEqual(await run.result(), { outcome: "aborted" });
  assert.deepEqual(facts, []);
  assert.deepEqual(calls, [
    {
      kind: "abort",
      sessionKey: "agent:acct:ses_abort_active_1",
      runId: "host-run-1",
    },
  ]);
});

test("provider adapter createSession generates ses_ prefixed ids and stores requested title locally", async () => {
  const sessionRegistry = new SessionRegistry("agent:acct");
  const provider = createAdapter({ sessionRegistry });

  const created = await provider.createSession({
    traceId: "trace-1",
    title: "Requested Title",
  });

  assert.match(created.toolSessionId, /^ses_/);
  assert.equal(sessionRegistry.get(created.toolSessionId).title, "Requested Title");
});

test("provider adapter rejects question replies as unsupported", async () => {
  const provider = createAdapter();

  await assert.rejects(
    provider.replyQuestion({
      traceId: "trace-1",
      questionId: "question-1",
      answers: [["yes"]],
    }),
    (error) =>
      error?.code === "not_supported"
      && /does not support question replies/.test(error.message),
  );
});

test("provider adapter abort prefers runtime abort hook over session deletion", async () => {
  const calls = [];
  const sessionRegistry = new SessionRegistry("agent:acct");
  sessionRegistry.ensure("tool-1");
  const provider = createAdapter({
    sessionRegistry,
    runtime: {
      channel: {
        reply: {
          async abortRun(input) {
            calls.push({ kind: "abort", ...input });
          },
        },
      },
    },
    getSubagentRuntime: () => ({
      async run() {
        return { runId: "sub-1" };
      },
      async waitForRun() {
        return { status: "ok" };
      },
      async getSessionMessages() {
        return { messages: [] };
      },
      async deleteSession() {
        calls.push({ kind: "delete" });
      },
    }),
  });

  const result = await provider.abortSession({
    traceId: "trace-1",
    toolSessionId: "tool-1",
    runId: "run-1",
  });

  assert.deepEqual(result, { applied: true });
  assert.deepEqual(calls, [
    {
      kind: "abort",
      sessionKey: "agent:acct:tool-1",
      runId: "run-1",
    },
  ]);
});

test("provider adapter serializes tool input and output from runtime events", async () => {
  const listeners = [];
  let finishRun;
  const provider = createAdapter({
    runtime: {
      events: {
        onAgentEvent(listener) {
          listeners.push(listener);
          return () => true;
        },
      },
    },
    getSubagentRuntime: () => ({
      async run() {
        return { runId: "sub-1" };
      },
      async waitForRun() {
        return await new Promise((resolve) => {
          finishRun = () => resolve({ status: "ok" });
        });
      },
      async getSessionMessages() {
        return {
          messages: [{ role: "assistant", content: "done" }],
        };
      },
    }),
  });

  await provider.initialize();
  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "run-1",
    toolSessionId: "ses_tool_payload_1",
    text: "hi",
  });

  listeners[0]({
    stream: "tool",
    sessionKey: "agent:acct:ses_tool_payload_1",
    data: {
      phase: "update",
      toolCallId: "call-1",
      name: "web_search",
      args: {
        query: "OpenAI API latest docs",
        limit: 5,
      },
    },
  });
  listeners[0]({
    stream: "tool",
    sessionKey: "agent:acct:ses_tool_payload_1",
    data: {
      phase: "result",
      toolCallId: "call-1",
      name: "web_search",
      result: {
        items: [{ title: "Docs", url: "https://platform.openai.com/docs" }],
      },
    },
  });
  finishRun();

  const facts = [];
  for await (const fact of run.facts) {
    facts.push(fact);
  }

  const toolFacts = facts.filter((fact) => fact.type === "tool.update");
  assert.deepEqual(
    toolFacts.map((fact) => ({
      status: fact.status,
      input: fact.input,
      output: fact.output,
    })),
    [
      {
        status: "running",
        input: '{"query":"OpenAI API latest docs","limit":5}',
        output: undefined,
      },
      {
        status: "completed",
        input: '{"query":"OpenAI API latest docs","limit":5}',
        output: '{"items":[{"title":"Docs","url":"https://platform.openai.com/docs"}]}',
      },
    ],
  );
});

test("provider adapter maps runtime assistant events to text delta facts", async () => {
  const listeners = [];
  let finishRun;
  const provider = createAdapter({
    runtime: {
      events: {
        onAgentEvent(listener) {
          listeners.push(listener);
          return () => true;
        },
      },
    },
    getSubagentRuntime: () => ({
      async run() {
        return { runId: "sub-1" };
      },
      async waitForRun() {
        return await new Promise((resolve) => {
          finishRun = () => resolve({ status: "ok" });
        });
      },
      async getSessionMessages() {
        return {
          messages: [{ role: "assistant", content: "hello world" }],
        };
      },
    }),
  });

  await provider.initialize();
  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "run-1",
    toolSessionId: "ses_stream_1",
    text: "hi",
  });

  listeners[0]({
    stream: "assistant",
    sessionKey: "agent:acct:ses_stream_1",
    data: {
      text: "hello",
      delta: "hello",
    },
  });
  listeners[0]({
    stream: "assistant",
    sessionKey: "agent:acct:ses_stream_1",
    data: {
      text: "hello world",
    },
  });
  finishRun();

  const facts = [];
  for await (const fact of run.facts) {
    facts.push(fact);
  }

  assert.deepEqual(
    facts.map((fact) => fact.type),
    ["message.start", "text.delta", "text.delta", "text.done", "message.done"],
  );
  assert.deepEqual(
    facts.filter((fact) => fact.type === "text.delta").map((fact) => fact.content),
    ["hello", " world"],
  );
  assert.equal(facts.find((fact) => fact.type === "text.done").content, "hello world");
});

test("provider adapter maps runtime reasoning events to thinking facts", async () => {
  const listeners = [];
  let finishRun;
  const provider = createAdapter({
    runtime: {
      events: {
        onAgentEvent(listener) {
          listeners.push(listener);
          return () => true;
        },
      },
    },
    getSubagentRuntime: () => ({
      async run() {
        return { runId: "sub-1" };
      },
      async waitForRun() {
        return await new Promise((resolve) => {
          finishRun = () => resolve({ status: "ok" });
        });
      },
      async getSessionMessages() {
        return {
          messages: [{ role: "assistant", content: "done" }],
        };
      },
    }),
  });

  await provider.initialize();
  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "run-1",
    toolSessionId: "ses_reasoning_1",
    text: "hi",
  });

  listeners[0]({
    stream: "reasoning",
    sessionKey: "agent:acct:ses_reasoning_1",
    data: {
      phase: "delta",
      text: "thinking",
    },
  });
  listeners[0]({
    stream: "reasoning",
    sessionKey: "agent:acct:ses_reasoning_1",
    data: {
      phase: "finish",
    },
  });
  finishRun();

  const facts = [];
  for await (const fact of run.facts) {
    facts.push(fact);
  }

  assert.deepEqual(
    facts.map((fact) => fact.type),
    ["message.start", "thinking.delta", "thinking.done", "text.done", "message.done"],
  );
  assert.equal(facts.find((fact) => fact.type === "thinking.delta").content, "thinking");
  assert.equal(facts.find((fact) => fact.type === "thinking.done").content, "thinking");
});

test("provider adapter suppresses assistant deltas when account streaming is disabled", async () => {
  const listeners = [];
  let finishRun;
  const provider = createAdapter({
    account: {
      accountId: "acct",
      agentIdPrefix: "agent",
      runTimeoutMs: 1000,
      streaming: false,
    },
    runtime: {
      events: {
        onAgentEvent(listener) {
          listeners.push(listener);
          return () => true;
        },
      },
    },
    getSubagentRuntime: () => ({
      async run() {
        return { runId: "sub-1" };
      },
      async waitForRun() {
        return await new Promise((resolve) => {
          finishRun = () => resolve({ status: "ok" });
        });
      },
      async getSessionMessages() {
        return {
          messages: [{ role: "assistant", content: "final answer" }],
        };
      },
    }),
  });

  await provider.initialize();
  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "run-1",
    toolSessionId: "ses_stream_disabled_1",
    text: "hi",
  });

  listeners[0]({
    stream: "assistant",
    sessionKey: "agent:acct:ses_stream_disabled_1",
    data: {
      text: "partial",
      delta: "partial",
    },
  });
  finishRun();

  const facts = [];
  for await (const fact of run.facts) {
    facts.push(fact);
  }

  assert.deepEqual(
    facts.map((fact) => fact.type),
    ["message.start", "text.done", "message.done"],
  );
  assert.equal(facts.find((fact) => fact.type === "text.done").content, "final answer");
});

test("provider adapter suppresses runtime reply block deltas when config streaming is disabled", async () => {
  const provider = createAdapter({
    config: {
      channels: {
        "message-bridge": {
          streaming: false,
        },
      },
    },
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute() {
            return { accountId: "acct", agentId: "agent" };
          },
        },
        reply: {
          resolveEnvelopeFormatOptions() {
            return {};
          },
          formatAgentEnvelope({ body }) {
            return body;
          },
          finalizeInboundContext(input) {
            return input;
          },
          async dispatchReplyWithBufferedBlockDispatcher({ dispatcherOptions }) {
            await dispatcherOptions.deliver({ text: "partial" }, { kind: "block" });
            await dispatcherOptions.deliver({ text: "partial final" }, { kind: "final" });
          },
        },
      },
    },
  });

  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "run-1",
    toolSessionId: "ses_reply_stream_disabled_1",
    text: "hi",
  });

  const facts = [];
  for await (const fact of run.facts) {
    facts.push(fact);
  }

  assert.deepEqual(
    facts.map((fact) => fact.type),
    ["message.start", "text.done", "message.done"],
  );
  assert.equal(facts.find((fact) => fact.type === "text.done").content, "partial final");
});

test("provider adapter maps runtime approval gateway events and resolves permissions", async () => {
  let gatewayListener;
  const emitted = [];
  const requests = [];
  const provider = createAdapter({
    runtime: {
      events: {
        onGatewayEvent(listener) {
          gatewayListener = listener;
          return () => true;
        },
      },
      async request(method, params) {
        requests.push({ method, params });
      },
    },
  });

  await provider.initialize({
    outbound: {
      async emitOutboundMessage(input) {
        const facts = [];
        for await (const fact of input.facts) {
          facts.push(fact);
        }
        emitted.push({ input, facts });
        return { applied: true };
      },
    },
  });

  gatewayListener({
    event: "exec.approval.requested",
    payload: {
      id: "approval-1",
      sessionID: "ses_gateway_permission_1",
      title: "Run command?",
      type: "exec",
      metadata: {
        command: "echo hi",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(emitted.length, 1);
  assert.deepEqual(
    emitted[0].facts.map((fact) => fact.type),
    ["message.start", "permission.ask", "message.done"],
  );
  const permissionFact = emitted[0].facts.find((fact) => fact.type === "permission.ask");
  assert.equal(permissionFact.toolSessionId, "ses_gateway_permission_1");
  assert.equal(permissionFact.permissionId, "approval-1");
  assert.equal(permissionFact.permissionType, "exec");
  assert.match(permissionFact.partId, /^part_/);
  assert.equal(permissionFact.title, "Run command?");
  assert.equal(permissionFact.metadata.command, "echo hi");
  assert.equal(permissionFact.metadata.title, undefined);

  await provider.replyPermission({
    traceId: "trace-1",
    permissionId: "approval-1",
    reply: "once",
  });

  assert.deepEqual(requests, [
    {
      method: "exec.approval.resolve",
      params: {
        id: "approval-1",
        decision: "allow-once",
      },
    },
  ]);
});

test("provider adapter emits session.title only for changed runtime session title events", async () => {
  let gatewayListener;
  const emitted = [];
  const sessionRegistry = new SessionRegistry("agent:acct");
  sessionRegistry.ensure("ses_title_1", undefined, { title: "Requested Title" });
  const provider = createAdapter({
    sessionRegistry,
    runtime: {
      events: {
        onGatewayEvent(listener) {
          gatewayListener = listener;
          return () => true;
        },
      },
    },
  });

  await provider.initialize({
    outbound: {
      async emitOutboundMessage(input) {
        const facts = [];
        for await (const fact of input.facts) {
          facts.push(fact);
        }
        emitted.push({ input, facts });
        return { applied: true };
      },
    },
  });

  gatewayListener({
    event: "session.updated",
    payload: {
      sessionID: "ses_title_1",
      info: {
        title: "Requested Title",
      },
    },
  });
  await flushEvents();

  gatewayListener({
    event: "session.updated",
    payload: {
      sessionID: "ses_title_1",
      info: {
        title: "Runtime Generated Title",
      },
    },
  });
  await flushEvents();

  gatewayListener({
    event: "session.updated",
    payload: {
      sessionID: "ses_title_1",
      info: {
        title: "Runtime Generated Title",
      },
    },
  });
  await flushEvents();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].input.toolSessionId, "ses_title_1");
  assert.equal(emitted[0].input.trigger, "session.updated");
  assert.deepEqual(emitted[0].facts, [
    {
      type: "session.title",
      toolSessionId: "ses_title_1",
      title: "Runtime Generated Title",
      raw: {
        sessionID: "ses_title_1",
        info: {
          title: "Runtime Generated Title",
        },
      },
    },
  ]);
  assert.equal(sessionRegistry.get("ses_title_1").title, "Runtime Generated Title");
});

test("provider adapter rejects unknown permission replies", async () => {
  const provider = createAdapter();

  await assert.rejects(
    provider.replyPermission({
      traceId: "trace-1",
      permissionId: "missing",
      reply: "once",
    }),
    (error) => error?.code === "not_found" && /Permission approval not found/.test(error.message),
  );
});

test("provider adapter rejects resolved approval replies", async () => {
  let gatewayListener;
  const provider = createAdapter({
    runtime: {
      events: {
        onGatewayEvent(listener) {
          gatewayListener = listener;
          return () => true;
        },
      },
      async request() {},
    },
  });

  await provider.initialize({
    outbound: {
      async emitOutboundMessage() {
        return { applied: true };
      },
    },
  });

  gatewayListener({
    event: "exec.approval.requested",
    payload: {
      id: "approval-1",
      sessionID: "ses_gateway_permission_1",
      title: "Run command?",
      type: "exec",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  gatewayListener({
    event: "exec.approval.resolved",
    payload: {
      id: "approval-1",
    },
  });

  await assert.rejects(
    provider.replyPermission({
      traceId: "trace-1",
      permissionId: "approval-1",
      reply: "once",
    }),
    (error) =>
      error?.code === "invalid_input"
      && /already resolved/.test(error.message),
  );
});

test("provider adapter ignores question and permission runtime streams", async () => {
  const listeners = [];
  let finishRun;
  const provider = createAdapter({
    runtime: {
      events: {
        onAgentEvent(listener) {
          listeners.push(listener);
          return () => true;
        },
      },
    },
    getSubagentRuntime: () => ({
      async run() {
        return { runId: "sub-1" };
      },
      async waitForRun() {
        return await new Promise((resolve) => {
          finishRun = () => resolve({ status: "ok" });
        });
      },
      async getSessionMessages() {
        return {
          messages: [{ role: "assistant", content: "done" }],
        };
      },
    }),
  });

  await provider.initialize();
  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "run-1",
    toolSessionId: "ses_ignore_runtime_streams",
    text: "hi",
  });

  listeners[0]({
    stream: "question",
    sessionKey: "agent:acct:ses_ignore_runtime_streams",
    data: {
      toolCallId: "call-1",
      question: "continue?",
    },
  });
  listeners[0]({
    stream: "permission",
    sessionKey: "agent:acct:ses_ignore_runtime_streams",
    data: {
      permissionId: "perm-1",
    },
  });
  finishRun();

  const facts = [];
  for await (const fact of run.facts) {
    facts.push(fact);
  }

  assert.equal(facts.some((fact) => fact.type === "question.ask"), false);
  assert.equal(
    facts.some((fact) => fact.type === "permission.ask" && fact.permissionId === "perm-1"),
    false,
  );
});

test("provider adapter debug logs raw runtime agent and reply dispatcher events", async () => {
  const debugLogs = [];
  const provider = createAdapter({
    account: {
      accountId: "acct",
      agentIdPrefix: "agent",
      runTimeoutMs: 1000,
      debug: true,
    },
    logger: createLogger({
      debug(message, meta) {
        debugLogs.push({ message, meta });
      },
    }),
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute() {
            return { accountId: "acct", agentId: "agent" };
          },
        },
        reply: {
          resolveEnvelopeFormatOptions() {
            return {};
          },
          formatAgentEnvelope({ body }) {
            return body;
          },
          finalizeInboundContext(input) {
            return input;
          },
          async dispatchReplyWithBufferedBlockDispatcher({ ctx, dispatcherOptions }) {
            await dispatcherOptions.deliver({ text: "hello" }, { kind: "block" });
            provider["handleRuntimeAgentEvent"]({
              stream: "assistant",
              sessionKey: ctx.SessionKey,
              data: {
                text: "hello",
                delta: "hello",
              },
            });
            await dispatcherOptions.deliver({ text: "hello" }, { kind: "final" });
          },
        },
      },
    },
  });

  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "run-1",
    toolSessionId: "ses_raw_1",
    text: "hi",
  });

  for await (const _fact of run.facts) {
    // drain facts
  }

  assert.deepEqual(
    debugLogs
      .filter((entry) => entry.message === "bridge.chat.raw_event")
      .map((entry) => ({
        source: entry.meta.source,
        eventName: entry.meta.eventName,
        toolSessionId: entry.meta.toolSessionId,
        payload: entry.meta.payload,
      })),
    [
      {
        source: "runtime_reply_dispatcher",
        eventName: "onBlock",
        toolSessionId: "ses_raw_1",
        payload: { text: "hello" },
      },
      {
        source: "runtime_agent_event",
        eventName: "assistant",
        toolSessionId: "ses_raw_1",
        payload: {
          stream: "assistant",
          sessionKey: "agent:acct:ses_raw_1",
          data: {
            text: "hello",
            delta: "hello",
          },
        },
      },
      {
        source: "runtime_reply_dispatcher",
        eventName: "onFinal",
        toolSessionId: "ses_raw_1",
        payload: { text: "hello" },
      },
    ],
  );
});
