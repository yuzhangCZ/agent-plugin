import test from "node:test";
import assert from "node:assert/strict";

import { OpenClawProviderAdapter } from "../../src/sdk/OpenClawProviderAdapter.ts";
import { SessionRegistry } from "../../src/session/SessionRegistry.ts";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
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

test("provider adapter forwards question replies to runtime reply host", async () => {
  const calls = [];
  const sessionRegistry = new SessionRegistry("agent:acct");
  sessionRegistry.ensure("tool-1");
  const provider = createAdapter({
    sessionRegistry,
    runtime: {
      channel: {
        reply: {
          async replyQuestion(input) {
            calls.push(input);
          },
        },
      },
    },
  });

  const result = await provider.replyQuestion({
    traceId: "trace-1",
    toolSessionId: "tool-1",
    toolCallId: "call-1",
    answer: "yes",
  });

  assert.deepEqual(result, { applied: true });
  assert.deepEqual(calls, [
    {
      sessionKey: "agent:acct:tool-1",
      toolCallId: "call-1",
      answer: "yes",
    },
  ]);
});

test("provider adapter forwards permission replies to runtime reply host", async () => {
  const calls = [];
  const sessionRegistry = new SessionRegistry("agent:acct");
  sessionRegistry.ensure("tool-1");
  const provider = createAdapter({
    sessionRegistry,
    runtime: {
      channel: {
        reply: {
          async replyPermission(input) {
            calls.push(input);
          },
        },
      },
    },
  });

  const result = await provider.replyPermission({
    traceId: "trace-1",
    toolSessionId: "tool-1",
    permissionId: "perm-1",
    response: "once",
  });

  assert.deepEqual(result, { applied: true });
  assert.deepEqual(calls, [
    {
      sessionKey: "agent:acct:tool-1",
      permissionId: "perm-1",
      response: "once",
    },
  ]);
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
