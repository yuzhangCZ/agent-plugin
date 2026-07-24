import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeRuntime } from '@/index.ts';
import type { ProviderTerminalResult, ThirdPartyAgentProvider } from '@/index.ts';
import {
  createAsyncFacts,
  createDeferred,
  createFakeRun,
  createProvider,
  createRuntimeOptions,
  FakeGatewayClient,
  flushEvents,
} from '../support/runtime-harness.ts';

async function waitFor(condition: () => boolean, failureMessage: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await flushEvents();
  }
  assert.fail(failureMessage);
}

test('runtime projects subagent envelope fields from provider facts onto tool_event messages', async () => {
  const connection = new FakeGatewayClient();
  const provider: ThirdPartyAgentProvider = {
    async health() {
      return { online: true };
    },
    async createSession() {
      return { toolSessionId: 'tool-parent-1' };
    },
    async runMessage() {
      return createFakeRun(
        [
          {
            type: 'message.start',
            subagentSessionId: 'ses-child-1',
            subagentName: 'research-agent',
            messageId: 'msg-subagent-1',
          },
          {
            type: 'text.done',
            subagentSessionId: 'ses-child-1',
            subagentName: 'research-agent',
            messageId: 'msg-subagent-1',
            partId: 'part-subagent-1',
            content: 'hello from child',
          },
          {
            type: 'message.done',
            subagentSessionId: 'ses-child-1',
            subagentName: 'research-agent',
            messageId: 'msg-subagent-1',
          },
        ],
        { outcome: 'completed' },
      );
    },
    async replyQuestion() {
      return { applied: true };
    },
    async replyPermission() {
      return { applied: true };
    },
    async closeSession() {
      return { applied: true };
    },
    async abortSession() {
      return { applied: true };
    },
  };

  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));
  await runtime.start();

  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-subagent-1',
    payload: { toolSessionId: 'tool-parent-1', text: 'hi' },
  });
  await flushEvents();

  const toolEvents = connection.sent.filter(
    (message): message is Record<string, unknown> =>
      typeof message === 'object' && message !== null && 'type' in message && message.type === 'tool_event',
  );
  assert.equal(toolEvents.length >= 2, true);
  assert.equal(toolEvents.every((message) => message.subagentSessionId === 'ses-child-1'), true);
  assert.equal(toolEvents.every((message) => message.subagentName === 'research-agent'), true);
});

test('start_request_run reuses session welinkSessionId when chat invoke omits it', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'create_session',
    welinkSessionId: 'welink-1',
    payload: { title: 'demo' },
  });
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent[0], {
    type: 'session_created',
    welinkSessionId: 'welink-1',
    toolSessionId: 'tool-1',
    session: { sessionId: 'tool-1' },
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_done',
    toolSessionId: 'tool-1',
  });
});

test('start_request_run passes typed invoke.chat context to provider runMessage', async () => {
  const connection = new FakeGatewayClient();
  let capturedInput: Record<string, unknown> | undefined;
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage(input) {
          capturedInput = input as unknown as Record<string, unknown>;
          return createFakeRun([], { outcome: 'completed' });
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission() {
          return { applied: true };
        },
        async closeSession() {
          return { applied: true };
        },
        async abortSession() {
          return { applied: true };
        },
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    suppressReply: true,
    payload: {
      toolSessionId: 'tool-1',
      text: 'hi',
      assistantId: 'assistant-1',
      assistantAccount: 'assistant-account',
      sendUserAccount: 'user-account',
      imGroupId: 'group-1',
      extParameters: {
        businessExtParam: {
          scene: 'workflow',
          nested: {
            enabled: true,
          },
        },
        platformExtParam: {
          businessSessionDomain: 'im',
          businessSessionType: 'group',
          businessSessionId: 'session-1',
          allowedSlashCommands: ['plan', 'run'],
        },
      },
    },
  });
  await flushEvents();

  assert.equal(typeof capturedInput?.runId, 'string');
  assert.deepEqual(capturedInput, {
    traceId: 'trace-fixed',
    runId: capturedInput?.runId,
    toolSessionId: 'tool-1',
    text: 'hi',
    assistantId: 'assistant-1',
    extParameters: {
      businessExtParam: {
        scene: 'workflow',
        nested: {
          enabled: true,
        },
      },
      platformExtParam: {
        businessSessionDomain: 'im',
        businessSessionType: 'group',
        businessSessionId: 'session-1',
        allowedSlashCommands: ['plan', 'run'],
      },
    },
    context: {
      assistantAccount: 'assistant-account',
      sendUserAccount: 'user-account',
      suppressReply: true,
    },
  });
});

test('start_request_run does not synthesize extParameters from legacy imGroupId', async () => {
  const connection = new FakeGatewayClient();
  let capturedInput: Record<string, unknown> | undefined;
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage(input) {
          capturedInput = input as unknown as Record<string, unknown>;
          return createFakeRun([], { outcome: 'completed' });
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission() {
          return { applied: true };
        },
        async closeSession() {
          return { applied: true };
        },
        async abortSession() {
          return { applied: true };
        },
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    payload: {
      toolSessionId: 'tool-legacy-im',
      text: 'hi',
      imGroupId: 'group-legacy',
    },
  });
  await flushEvents();

  assert.equal(typeof capturedInput?.runId, 'string');
  assert.deepEqual(capturedInput, {
    traceId: 'trace-fixed',
    runId: capturedInput?.runId,
    toolSessionId: 'tool-legacy-im',
    text: 'hi',
  });
});

test('start_request_run omits absent extParameters in provider runMessage input', async () => {
  const connection = new FakeGatewayClient();
  let capturedInput: Record<string, unknown> | undefined;
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage(input) {
          capturedInput = input as unknown as Record<string, unknown>;
          return createFakeRun([], { outcome: 'completed' });
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission() {
          return { applied: true };
        },
        async closeSession() {
          return { applied: true };
        },
        async abortSession() {
          return { applied: true };
        },
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: {
      toolSessionId: 'tool-1',
      text: 'hi',
    },
  });
  await flushEvents();

  assert.ok(capturedInput);
  assert.equal('extParameters' in capturedInput, false);
});

test('request run projects session.error exactly once before terminal tool_error', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage() {
          return createFakeRun(
            [
              {
                type: 'session.error',
                error: {
                  code: 'internal_error',
                  message: 'agent offline',
                },
              },
            ],
            {
              outcome: 'failed',
              error: {
                code: 'internal_error',
                message: 'agent offline',
              },
            },
          );
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission() {
          return { applied: true };
        },
        async closeSession() {
          return { applied: true };
        },
        async abortSession() {
          return { applied: true };
        },
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  const sessionErrors = connection.sent.filter((message) =>
    typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'tool_event'
    && 'event' in message
    && typeof message.event === 'object'
    && message.event !== null
    && 'type' in message.event
    && message.event.type === 'session.error',
  );
  assert.equal(sessionErrors.length, 1);
  assert.deepEqual(sessionErrors[0], {
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      protocol: 'cloud',
      type: 'session.error',
      properties: {
        error: 'agent offline',
      },
    },
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: 'agent offline',
  });
});

test('request run sends terminal tool_error', async () => {
  const connection = new FakeGatewayClient();
  const provider = createProvider();
  provider.runMessage = async () => createFakeRun([], {
    outcome: 'failed',
    error: {
      code: 'internal_error',
      message: 'provider failed',
    },
  });
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: 'provider failed',
  });
});

test('active run chat policy forwardToProvider sends concurrent chat to provider with distinct run ids', async () => {
  const connection = new FakeGatewayClient();
  const firstRunResult = createDeferred<ProviderTerminalResult>();
  const secondRunResult = createDeferred<ProviderTerminalResult>();
  const runMessageInputs: Array<{ runId: string; text: string }> = [];
  const provider = createProvider();
  provider.runMessage = async (input) => {
    const result = runMessageInputs.length === 0 ? firstRunResult : secondRunResult;
    runMessageInputs.push({ runId: input.runId, text: input.text });
    return {
      runId: input.runId,
      facts: createAsyncFacts([]),
      result: async () => result.promise,
    };
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection, {
    requestRunPolicy: { activeRunChatPolicy: 'forwardToProvider' },
  }));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-2',
    payload: { toolSessionId: 'tool-1', text: 'second' },
  });
  await waitFor(() => runMessageInputs.length === 2, 'second request run did not reach the provider');

  assert.equal(runMessageInputs.length, 2);
  assert.notEqual(runMessageInputs[0]?.runId, runMessageInputs[1]?.runId);
  assert.deepEqual(runMessageInputs.map((input) => input.text), ['first', 'second']);
  firstRunResult.resolve({ outcome: 'completed' });
  secondRunResult.resolve({ outcome: 'completed' });
  await flushEvents();
});

test('provider failure releases only its concurrent request run before abort_session', async (t) => {
  const connection = new FakeGatewayClient();
  const firstRunResult = createDeferred<ProviderTerminalResult>();
  const runIds: string[] = [];
  let capturedAbortInput: Record<string, unknown> | undefined;
  const provider = createProvider();
  provider.runMessage = async (input) => {
    runIds.push(input.runId);
    if (runIds.length === 2) {
      throw new Error('provider_down');
    }
    return {
      runId: input.runId,
      facts: createAsyncFacts([]),
      result: async () => firstRunResult.promise,
    };
  };
  provider.abortSession = async (input) => {
    capturedAbortInput = input as unknown as Record<string, unknown>;
    return { applied: true };
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection, {
    requestRunPolicy: { activeRunChatPolicy: 'forwardToProvider' },
  }));
  t.after(async () => {
    firstRunResult.resolve({ outcome: 'aborted' });
    await flushEvents();
    await runtime.stop();
  });

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await waitFor(() => runIds.length === 1, 'first request run did not reach the provider');
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-2',
    payload: { toolSessionId: 'tool-1', text: 'second' },
  });
  await waitFor(
    () => connection.sent.some((message) => (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'tool_error'
      && 'toolSessionId' in message
      && message.toolSessionId === 'tool-1'
      && 'error' in message
      && message.error === 'provider_down'
    )),
    'failed request run did not reach its terminal error path',
  );
  await flushEvents();

  const firstRunId = runIds[0];
  assert.ok(firstRunId);
  connection.emitMessage({
    type: 'invoke',
    action: 'abort_session',
    welinkSessionId: 'welink-3',
    payload: { toolSessionId: 'tool-1' },
  });
  await waitFor(() => capturedAbortInput !== undefined, 'abort_session did not reach the provider');

  assert.deepEqual(capturedAbortInput?.runIds, [firstRunId]);

  firstRunResult.resolve({ outcome: 'aborted' });
  await waitFor(
    () => connection.sent.some((message) => (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'tool_done'
      && 'toolSessionId' in message
      && message.toolSessionId === 'tool-1'
    )),
    'first request run did not settle during cleanup',
  );
});

test('terminal tool_error carries session_not_found reason when provider returns structured stale-session error', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage() {
          return createFakeRun([], {
            outcome: 'failed',
            error: {
              code: 'session_not_found',
              message: 'session missing',
            },
          });
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission() {
          return { applied: true };
        },
        async closeSession() {
          return { applied: true };
        },
        async abortSession() {
          return { applied: true };
        },
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: 'session missing',
    reason: 'session_not_found',
  });
});

test('tool.update with non-string output fails closed before uplink projection', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage() {
          return createFakeRun(
            [
              { type: 'message.start', messageId: 'msg-1' },
              {
                type: 'tool.update',
                messageId: 'msg-1',
                partId: 'part-tool-1',
                toolCallId: 'tool-call-1',
                toolName: 'bash',
                status: 'completed',
                output: { nested: true } as unknown as string,
              },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission() {
          return { applied: true };
        },
        async closeSession() {
          return { applied: true };
        },
        async abortSession() {
          return { applied: true };
        },
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: '当前请求处理失败，请重试',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'tool.update output must be a string',
    code: 'fact_sequence_invalid',
  });
});
