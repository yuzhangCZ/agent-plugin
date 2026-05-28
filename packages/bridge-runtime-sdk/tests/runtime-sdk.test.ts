import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  BridgeGatewayHostConfig,
  BridgeRuntimeOptions,
  ProviderFact,
  ProviderRun,
  ProviderTerminalResult,
  ThirdPartyAgentProvider,
} from '../src/index.ts';
import type {
  BridgeGatewayHostConnection,
  BridgeGatewayHostError,
  BridgeGatewayHostState,
} from '../src/infrastructure/gateway/gateway-host.ts';
import { createBridgeRuntime } from '../src/index.ts';

function createAsyncFacts(facts: ProviderFact[]): AsyncIterable<ProviderFact> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const fact of facts) {
        yield fact;
      }
    },
  };
}

function createFakeRun(facts: ProviderFact[], result: ProviderTerminalResult): ProviderRun {
  return {
    runId: 'run-1',
    facts: createAsyncFacts(facts),
    async result() {
      return result;
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

class FakeGatewayClient extends EventEmitter implements BridgeGatewayHostConnection {
  sent: unknown[] = [];
  state: BridgeGatewayHostState = 'DISCONNECTED';
  connectError: Error | null = null;

  async connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    if (this.connectError) {
      throw this.connectError;
    }
    this.state = 'READY';
    this.emit('stateChange', this.state);
  }

  disconnect(): void {
    this.state = 'DISCONNECTED';
    this.emit('stateChange', this.state);
  }

  send(message: unknown): void {
    this.sent.push(message);
    this.emit('outbound', message);
  }

  isConnected(): boolean {
    return this.state === 'CONNECTED' || this.state === 'READY';
  }

  getState(): BridgeGatewayHostState {
    return this.state;
  }

  getStatus() {
    return {
      isReady: () => this.state === 'READY',
    };
  }

  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  emitMessage(message: unknown): void {
    this.emit('message', message);
  }

  emitInbound(frame: unknown): void {
    this.emit('inbound', frame);
  }

  emitHeartbeat(message: unknown): void {
    this.emit('heartbeat', message);
  }

  emitError(error: BridgeGatewayHostError): void {
    this.emit('error', error);
  }
}

function createRuntimeOptions(
  provider: ThirdPartyAgentProvider,
  connection: FakeGatewayClient,
  extra?: Partial<BridgeRuntimeOptions>,
): BridgeRuntimeOptions {
  return {
    provider,
    gatewayHost: {
      url: 'ws://gateway.local',
      auth: {
        ak: 'ak',
        sk: 'sk',
      },
      register: {
        toolType: 'openx',
        toolVersion: '0.0.0',
        pluginVersion: '0.1.0',
      },
    } satisfies BridgeGatewayHostConfig,
    connectionFactory: () => connection,
    traceIdFactory: () => 'trace-fixed',
    ...extra,
  };
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function createProvider(): ThirdPartyAgentProvider {
  return {
    async health() {
      return { online: true };
    },
    async createSession() {
      return { toolSessionId: 'tool-1' };
    },
    async runMessage() {
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
  };
}

function createInvalidInvokeInboundFrame() {
  return {
    kind: 'invalid',
    messageType: 'invoke',
    gatewayMessageId: 'gw-invalid-1',
    action: 'chat',
    welinkSessionId: 'wl-invalid-1',
    toolSessionId: 'tool-invalid-1',
    violation: {
      violation: {
        stage: 'payload',
        code: 'missing_required_field',
        field: 'payload.text',
        message: 'payload.text is required',
        messageType: 'invoke',
        action: 'chat',
        welinkSessionId: 'wl-invalid-1',
        toolSessionId: 'tool-invalid-1',
      },
    },
    rawPreview: {
      type: 'invoke',
      messageId: 'gw-invalid-1',
      action: 'chat',
      welinkSessionId: 'wl-invalid-1',
      payload: {
        toolSessionId: 'tool-invalid-1',
      },
    },
  };
}

test('runtime starts, consumes downstream messages from gateway-client, and projects uplinks', async () => {
  const connection = new FakeGatewayClient();
  const provider: ThirdPartyAgentProvider = {
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
          { type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: 'he' },
          { type: 'text.done', messageId: 'msg-1', partId: 'part-1', content: 'hello' },
          { type: 'message.done', messageId: 'msg-1' },
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
  assert.deepEqual(runtime.getStatus(), {
    state: 'ready',
    failureReason: null,
  });

  connection.emitMessage({
    type: 'invoke',
    action: 'create_session',
    welinkSessionId: 'welink-1',
    payload: { title: 'demo' },
  });
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
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
    welinkSessionId: 'welink-1',
  });
  assert.equal(
    connection.sent.some(
      (message) => typeof message === 'object' && message !== null && 'type' in message && message.type === 'tool_event',
    ),
    true,
  );

  await runtime.stop();
  assert.deepEqual(runtime.getStatus(), {
    state: 'idle',
    failureReason: null,
  });
});

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

test('abort_session forwards active run id and sends tool_done when run resolves aborted', async () => {
  const connection = new FakeGatewayClient();
  let finishFacts: (() => void) | undefined;
  let resolveTerminal: ((result: ProviderTerminalResult) => void) | undefined;
  let capturedAbortInput: Record<string, unknown> | undefined;
  let capturedRunId: string | undefined;
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
          capturedRunId = input.runId;
          const facts = {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                finishFacts = resolve;
              });
            },
          };
          return {
            runId: input.runId,
            facts,
            result() {
              return new Promise<ProviderTerminalResult>((resolve) => {
                resolveTerminal = resolve;
              });
            },
          };
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
        async abortSession(input) {
          capturedAbortInput = input as unknown as Record<string, unknown>;
          finishFacts?.();
          resolveTerminal?.({ outcome: 'aborted' });
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
  connection.emitMessage({
    type: 'invoke',
    action: 'abort_session',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1' },
  });
  await flushEvents();

  assert.ok(capturedRunId);
  assert.deepEqual(capturedAbortInput, {
    traceId: 'trace-fixed',
    toolSessionId: 'tool-1',
    runId: capturedRunId,
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_done',
    toolSessionId: 'tool-1',
    welinkSessionId: 'welink-1',
  });
});

test('abort_session without active request run passes undefined runId and keeps toolSessionId reusable', async () => {
  const connection = new FakeGatewayClient();
  let capturedAbortInput: Record<string, unknown> | undefined;
  let runCount = 0;
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        ...createProvider(),
        async runMessage() {
          runCount += 1;
          return createFakeRun(
            [
              { type: 'message.start', messageId: `msg-${runCount}` },
              { type: 'message.done', messageId: `msg-${runCount}` },
            ],
            { outcome: 'completed' },
          );
        },
        async abortSession(input) {
          capturedAbortInput = input as unknown as Record<string, unknown>;
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
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'abort_session',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'second' },
  });
  await flushEvents();

  assert.ok(capturedAbortInput);
  assert.equal(capturedAbortInput.runId, undefined);
  assert.equal(runCount, 2);
  assert.equal(
    connection.sent.filter((message) =>
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'tool_done'
      && 'toolSessionId' in message
      && message.toolSessionId === 'tool-1'
    ).length,
    2,
  );
});

test('abort_session keeps active request run occupied until aborted run settles', async () => {
  const connection = new FakeGatewayClient();
  const firstRunResult = createDeferred<ProviderTerminalResult>();
  let capturedAbortInput: Record<string, unknown> | undefined;
  let runCount = 0;
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        ...createProvider(),
        async runMessage(input) {
          runCount += 1;
          if (runCount === 1) {
            return {
              runId: input.runId,
              facts: createAsyncFacts([]),
              result: async () => firstRunResult.promise,
            };
          }
          return createFakeRun(
            [
              { type: 'message.start', messageId: `msg-${runCount}` },
              { type: 'message.done', messageId: `msg-${runCount}` },
            ],
            { outcome: 'completed' },
          );
        },
        async abortSession(input) {
          capturedAbortInput = input as unknown as Record<string, unknown>;
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
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'abort_session',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-2',
    payload: { toolSessionId: 'tool-1', text: 'second' },
  });
  await flushEvents();

  assert.equal(runCount, 1);
  assert.ok(capturedAbortInput?.runId);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    welinkSessionId: 'welink-2',
    error: '当前会话正在处理中，请稍后再试',
  });

  firstRunResult.resolve({ outcome: 'aborted' });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-3',
    payload: { toolSessionId: 'tool-1', text: 'third' },
  });
  await flushEvents();

  assert.equal(runCount, 2);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_done',
    toolSessionId: 'tool-1',
    welinkSessionId: 'welink-3',
  });
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
    welinkSessionId: 'welink-1',
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
      imGroupId: 'group-1',
      suppressReply: true,
    },
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

test('runtime consumes question replies by questionId and forwards structured answers', async () => {
  const connection = new FakeGatewayClient();
  let capturedQuestionReply: Record<string, unknown> | undefined;
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
                type: 'question.ask',
                messageId: 'msg-1',
                partId: 'part-question-1',
                questionId: 'question-1',
                status: 'running',
                extParam: { scene: 'confirm' },
                questions: [
                  {
                    question: 'Pick one',
                    header: 'Header',
                    options: [{ label: 'A' }, { label: 'B' }],
                  },
                ],
              },
              { type: 'message.done', messageId: 'msg-1' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion(input) {
          capturedQuestionReply = input as unknown as Record<string, unknown>;
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
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    payload: { questionId: 'question-1', answer: 'A' },
  });
  await flushEvents();

  assert.deepEqual(capturedQuestionReply, {
    traceId: 'trace-fixed',
    questionId: 'question-1',
    answers: [['A']],
  });
});

test('runtime consumes permission replies by permissionId and forwards reply contract', async () => {
  const connection = new FakeGatewayClient();
  let capturedPermissionReply: Record<string, unknown> | undefined;
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
                type: 'permission.ask',
                messageId: 'msg-1',
                partId: 'part-permission-1',
                permissionId: 'permission-1',
              },
              { type: 'message.done', messageId: 'msg-1' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission(input) {
          capturedPermissionReply = input as unknown as Record<string, unknown>;
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
  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-1', response: 'always' },
  });
  await flushEvents();

  assert.deepEqual(capturedPermissionReply, {
    traceId: 'trace-fixed',
    permissionId: 'permission-1',
    reply: 'always',
  });
});

test('question.ask projects cloud questions payload and omits legacy flat fields', async () => {
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
                type: 'question.ask',
                messageId: 'msg-1',
                partId: 'part-question-1',
                questionId: 'question-1',
                toolCallId: 'call-question-1',
                status: 'running',
                extParam: { scene: 'confirm' },
                questions: [
                  {
                    question: 'Pick one',
                    header: 'Header',
                    options: [{ label: 'A' }, { label: 'B' }],
                    multiSelect: true,
                  },
                ],
              },
              { type: 'message.done', messageId: 'msg-1' },
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

  const questionEvent = connection.sent.find((message) =>
    typeof message === 'object'
    && message !== null
    && 'type' in message
    && message.type === 'tool_event'
    && 'event' in message
    && typeof message.event === 'object'
    && message.event !== null
    && 'type' in message.event
    && message.event.type === 'question',
  );
  assert.deepEqual(questionEvent, {
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      protocol: 'cloud',
      type: 'question',
      properties: {
        messageId: 'msg-1',
        partId: 'part-question-1',
        questionId: 'question-1',
        toolCallId: 'call-question-1',
        status: 'running',
        extParam: { scene: 'confirm' },
        questions: [
          {
            question: 'Pick one',
            header: 'Header',
            options: [{ label: 'A' }, { label: 'B' }],
            multiSelect: true,
          },
        ],
      },
    },
  });
});

test('permission.reply and session.title facts project to gateway tool_event uplinks', async () => {
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
                type: 'permission.ask',
                permissionId: 'permission-1',
                partId: 'part-1',
                messageId: 'msg-1',
                permissionType: 'file_write',
              },
              {
                type: 'permission.reply',
                permissionId: 'permission-1',
                response: 'once',
                permissionType: 'file_write',
              },
              {
                type: 'session.title',
                title: 'Updated Title',
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

  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'permission.reply',
        properties: {
          permissionId: 'permission-1',
          response: 'once',
          permType: 'file_write',
          messageId: 'msg-1',
          partId: 'part-1',
        },
      },
    })),
    true,
  );
  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'session.title',
        properties: {
          title: 'Updated Title',
        },
      },
    })),
    true,
  );
});

test('permission.reply without ask presentation context does not emit permission reply tool_event', async () => {
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
                type: 'permission.reply',
                permissionId: 'permission-missing-1',
                response: 'once',
                permissionType: 'file_write',
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

  assert.equal(
    connection.sent.some((message) =>
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'tool_event'
      && 'event' in message
      && typeof message.event === 'object'
      && message.event !== null
      && 'type' in message.event
      && message.event.type === 'permission.reply'),
    false,
  );
});

test('question.ask duplicate registration in the same session is idempotent', async () => {
  const connection = new FakeGatewayClient();
  let replyCount = 0;
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
                type: 'question.ask',
                messageId: 'msg-1',
                partId: 'part-question-1',
                questionId: 'question-1',
                questions: [{ question: 'Pick one' }],
              },
              {
                type: 'question.ask',
                messageId: 'msg-1',
                partId: 'part-question-1',
                questionId: 'question-1',
                questions: [{ question: 'Pick one' }],
              },
              { type: 'message.done', messageId: 'msg-1' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          replyCount += 1;
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
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    payload: { questionId: 'question-1', answer: 'A' },
  });
  await flushEvents();

  assert.equal(replyCount, 1);
  assert.equal(runtime.getStatus().state, 'ready');
  assert.notDeepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'question interaction reply target must be globally unique',
    code: 'pending_interaction_conflict',
  });
});

test('question.ask backfills toolCallId from questionId when fact omits legacy field', async () => {
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
                type: 'question.ask',
                messageId: 'msg-1',
                partId: 'part-question-2',
                questionId: 'question-2',
                questions: [{ question: 'Proceed?' }],
              },
              { type: 'message.done', messageId: 'msg-1' },
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

  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'question',
        properties: {
          messageId: 'msg-1',
          partId: 'part-question-2',
          questionId: 'question-2',
          toolCallId: 'question-2',
          questions: [{ question: 'Proceed?' }],
        },
      },
    })),
    true,
  );
});

test('permission.ask projects independent partId and permissionId only', async () => {
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
                type: 'permission.ask',
                messageId: 'msg-1',
                partId: 'part-permission-1',
                permissionId: 'permission-1',
                permissionType: 'file_write',
                title: 'Allow file write',
              },
              { type: 'message.done', messageId: 'msg-1' },
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

  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'permission.ask',
        properties: {
          messageId: 'msg-1',
          partId: 'part-permission-1',
          permissionId: 'permission-1',
          permType: 'file_write',
          title: 'Allow file write',
        },
      },
    })),
    true,
  );
});

test('permission.ask remains valid without messageId and still registers reply target', async () => {
  const connection = new FakeGatewayClient();
  let replyCount = 0;
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
                type: 'permission.ask',
                partId: 'permission-1',
                permissionId: 'permission-1',
                permissionType: 'file_write',
                title: 'Allow file write',
              },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission() {
          replyCount += 1;
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

  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'permission.ask',
        properties: {
          partId: 'permission-1',
          permissionId: 'permission-1',
          permType: 'file_write',
          title: 'Allow file write',
        },
      },
    })),
    true,
  );

  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-1', response: 'once' },
  });
  await flushEvents();

  assert.equal(replyCount, 1);
  assert.equal(runtime.getStatus().state, 'ready');
});

test('question.ask rejects globally duplicated questionId across sessions and clears current session pending interactions', async () => {
  const connection = new FakeGatewayClient();
  let replyCount = 0;
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
          if (input.toolSessionId === 'tool-1') {
            return createFakeRun(
              [
                { type: 'message.start', messageId: 'msg-1' },
                {
                  type: 'question.ask',
                  messageId: 'msg-1',
                  partId: 'part-question-1',
                  questionId: 'question-dup',
                  questions: [{ question: 'First question' }],
                },
                { type: 'message.done', messageId: 'msg-1' },
              ],
              { outcome: 'completed' },
            );
          }
          return createFakeRun(
            [
              { type: 'message.start', messageId: 'msg-2' },
              {
                type: 'question.ask',
                messageId: 'msg-2',
                partId: 'part-question-2',
                questionId: 'question-dup',
                questions: [{ question: 'Second question' }],
              },
              { type: 'message.done', messageId: 'msg-2' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          replyCount += 1;
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
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-2',
    payload: { toolSessionId: 'tool-2', text: 'second' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    payload: { questionId: 'question-dup', answer: 'A' },
  });
  await flushEvents();

  assert.equal(replyCount, 1);
  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-2',
    welinkSessionId: 'welink-2',
    error: '当前请求处理失败，请重试',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'question interaction reply target must be globally unique',
    code: 'pending_interaction_conflict',
  });
});

test('permission.ask rejects globally duplicated permissionId across sessions and clears current session pending interactions', async () => {
  const connection = new FakeGatewayClient();
  let replyCount = 0;
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
          if (input.toolSessionId === 'tool-1') {
            return createFakeRun(
              [
                { type: 'message.start', messageId: 'msg-1' },
                {
                  type: 'permission.ask',
                  messageId: 'msg-1',
                  partId: 'part-permission-1',
                  permissionId: 'permission-dup',
                },
                { type: 'message.done', messageId: 'msg-1' },
              ],
              { outcome: 'completed' },
            );
          }
          return createFakeRun(
            [
              { type: 'message.start', messageId: 'msg-2' },
              {
                type: 'permission.ask',
                messageId: 'msg-2',
                partId: 'part-permission-2',
                permissionId: 'permission-dup',
              },
              { type: 'message.done', messageId: 'msg-2' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission() {
          replyCount += 1;
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
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-2',
    payload: { toolSessionId: 'tool-2', text: 'second' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-dup', response: 'once' },
  });
  await flushEvents();

  assert.equal(replyCount, 1);
  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-2',
    welinkSessionId: 'welink-2',
    error: '当前请求处理失败，请重试',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'permission interaction reply target must be globally unique',
    code: 'pending_interaction_conflict',
  });
});

test('runtime start trusts gateway-client connect READY contract', async () => {
  const connection = new FakeGatewayClient();
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    await flushEvents();
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  assert.equal(runtime.getStatus().state, 'ready');
});

test('runtime start disconnects owned connection when startup fails after connection creation', async () => {
  const connection = new FakeGatewayClient();
  let disconnectCalls = 0;
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTED';
    this.emit('stateChange', this.state);
    throw new Error('connect_failed_after_open');
  };
  connection.disconnect = function disconnect(): void {
    disconnectCalls += 1;
    this.state = 'DISCONNECTED';
    this.emit('stateChange', this.state);
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await assert.rejects(runtime.start(), /connect_failed_after_open/);

  assert.equal(disconnectCalls, 1);
  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'connect_failed_after_open',
  });
});

test('runtime start rejects and enters failed when provider initialize fails', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async initialize() {
          throw new Error('provider_init_failed');
        },
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage() {
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

  await assert.rejects(runtime.start(), /provider_init_failed/);
  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'provider_init_failed',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'startup_failure',
    phase: 'start',
    message: 'provider_init_failed',
    code: undefined,
  });
});

test('runtime reflects reconnecting and returns to ready after gateway reconnects', async () => {
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
  connection.disconnect();
  assert.equal(runtime.getStatus().state, 'reconnecting');

  await connection.connect();
  assert.deepEqual(runtime.getStatus(), {
    state: 'ready',
    failureReason: null,
  });
});

test('request-level command failures stay ready and record command_execution_failure', async () => {
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
          throw new Error('run_failed');
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
    welinkSessionId: 'welink-1',
    error: 'run_failed',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'command_execution_failure',
    phase: 'runtime',
    message: 'run_failed',
    code: undefined,
  });
  assert.equal(runtime.getStatus().failureReason, null);
});

test('create_session command failure with routable welinkSessionId projects tool_error', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          throw new Error('create_session_failed');
        },
        async runMessage() {
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
    action: 'create_session',
    welinkSessionId: 'welink-create-1',
    payload: { title: 'demo' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    welinkSessionId: 'welink-create-1',
    error: 'create_session_failed',
  });
});

test('question_reply missing pending interaction projects tool_error', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    welinkSessionId: 'welink-question-missing-1',
    payload: { questionId: 'question-missing-1', answer: 'A' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    welinkSessionId: 'welink-question-missing-1',
    error: '当前交互已失效，请刷新后重试',
  });
});

test('permission_reply missing pending interaction projects tool_error', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    welinkSessionId: 'welink-permission-missing-1',
    payload: { permissionId: 'permission-missing-1', response: 'once' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    welinkSessionId: 'welink-permission-missing-1',
    error: '当前交互已失效，请刷新后重试',
  });
});

test('run_already_active projects routable tool_error while preserving active request run lock', async () => {
  const connection = new FakeGatewayClient();
  const firstRunResult = createDeferred<ProviderTerminalResult>();
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
          return {
            runId: 'run-hanging-1',
            facts: createAsyncFacts([]),
            result: async () => firstRunResult.promise,
          };
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
    welinkSessionId: 'welink-run-1',
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-run-2',
    payload: { toolSessionId: 'tool-1', text: 'second' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    welinkSessionId: 'welink-run-2',
    error: '当前会话正在处理中，请稍后再试',
  });
  firstRunResult.resolve({ outcome: 'completed' });
  await flushEvents();
});

test('invalid downstream messages stay ready and record inbound_validation_failure', async () => {
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
    action: 'unsupported_action',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'inbound_validation_failure',
    phase: 'runtime',
    message: 'Unsupported downstream action: unsupported_action',
    code: undefined,
  });
  assert.equal(runtime.getStatus().failureReason, null);
});

test('runtime handles invalid invoke inbound frames and records transport diagnostics', async () => {
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
  connection.emitInbound(createInvalidInvokeInboundFrame());
  connection.emitHeartbeat({ type: 'heartbeat' });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    welinkSessionId: 'wl-invalid-1',
    toolSessionId: 'tool-invalid-1',
    error: 'gateway_invalid_invoke:missing_required_field',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'inbound_validation_failure',
    phase: 'runtime',
    message: 'payload.text is required',
    code: 'missing_required_field',
  });
  assert.equal(runtime.getDiagnostics().gatewayState, 'READY');
  assert.equal(typeof runtime.getDiagnostics().lastInboundAt, 'number');
  assert.equal(typeof runtime.getDiagnostics().lastOutboundAt, 'number');
  assert.equal(typeof runtime.getDiagnostics().lastHeartbeatAt, 'number');
  assert.equal(runtime.getStatus().failureReason, null);
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
    welinkSessionId: 'welink-1',
    error: 'agent offline',
  });
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
    welinkSessionId: 'welink-1',
    error: 'session missing',
    reason: 'session_not_found',
  });
});

test('invalid outbound messages stay ready and record outbound_validation_failure', async () => {
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
            [{ type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: 'bad' }],
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
    welinkSessionId: 'welink-1',
    error: '当前请求处理失败，请重试',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'text.delta requires an open message',
    code: 'fact_sequence_invalid',
  });
  assert.equal(runtime.getStatus().failureReason, null);
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
    welinkSessionId: 'welink-1',
    error: '当前请求处理失败，请重试',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'tool.update output must be a string',
    code: 'fact_sequence_invalid',
  });
});

test('runtime marks non-retryable gateway errors as failed', async () => {
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
  connection.emitError({
    code: 'GATEWAY_HANDSHAKE_REJECTED',
    disposition: 'runtime_failure',
    stage: 'ready',
    retryable: false,
    message: 'rejected',
  });
  await flushEvents();

  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'rejected',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'gateway_runtime_failure',
    phase: 'runtime',
    message: 'rejected',
    code: 'GATEWAY_HANDSHAKE_REJECTED',
  });
});

test('probe passes the same public gatewayHost contract to connectionFactory as start', async () => {
  const configs: BridgeGatewayHostConfig[] = [];
  const runtimeConnection = new FakeGatewayClient();
  const probeConnection = new FakeGatewayClient();
  let factoryCalls = 0;
  const gatewayHost: BridgeGatewayHostConfig = {
    url: 'ws://gateway.local',
    auth: {
      ak: 'ak',
      sk: 'sk',
    },
    register: {
      toolType: 'openx',
      toolVersion: '0.0.0',
      pluginVersion: '0.1.0',
    },
  };
  const runtime = await createBridgeRuntime({
    ...createRuntimeOptions(createProvider(), runtimeConnection, {
      gatewayHost,
      connectionFactory: (config) => {
        configs.push(config);
        factoryCalls += 1;
        return factoryCalls === 1 ? runtimeConnection : probeConnection;
      },
    }),
  });

  await runtime.start();
  await runtime.stop();
  const result = await runtime.probe({ timeoutMs: 50 });

  assert.equal(result.state, 'ready');
  assert.equal(configs.length, 2);
  assert.deepEqual(configs[0], gatewayHost);
  assert.deepEqual(configs[1], gatewayHost);
  assert.deepEqual(Object.keys(configs[0]!), ['url', 'auth', 'register']);
  assert.deepEqual(Object.keys(configs[1]!), ['url', 'auth', 'register']);
});

test('failed start does not drift back to reconnecting or ready after later gateway events', async () => {
  const connection = new FakeGatewayClient();
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTED';
    this.emit('stateChange', this.state);
    throw new Error('connect_failed_after_open');
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await assert.rejects(runtime.start(), /connect_failed_after_open/);
  connection.emit('stateChange', 'READY');
  connection.emit('stateChange', 'DISCONNECTED');

  assert.deepEqual(runtime.getStatus(), {
    state: 'failed',
    failureReason: 'connect_failed_after_open',
  });
});

test('runtime diagnostics record lastReadyAt when gateway becomes ready', async () => {
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

  assert.equal(typeof runtime.getDiagnostics().lastReadyAt, 'number');
});

test('runtime probe short-circuits when same gateway url and ak runtime is ready', async () => {
  const runtimeConnection = new FakeGatewayClient();
  const probeConnection = new FakeGatewayClient();
  let probeConnectionAttempts = 0;
  const gatewayHost = {
    url: 'ws://gateway.local',
    auth: {
      ak: 'shared-ak',
      sk: 'shared-sk',
    },
    register: {
      toolType: 'openx',
      toolVersion: '0.0.0',
      pluginVersion: '0.1.0',
    },
  } satisfies BridgeGatewayHostConfig;
  const runtime = await createBridgeRuntime({
    provider: {
      async health() {
        return { online: true };
      },
      async createSession() {
        return { toolSessionId: 'tool-1' };
      },
      async runMessage() {
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
    gatewayHost,
    connectionFactory: () => runtimeConnection,
  });

  await runtime.start();

  const result = await runtime.probe({ timeoutMs: 50 });

  assert.deepEqual(result.state, 'ready');
  assert.equal(probeConnectionAttempts, 0);
});

test('different runtimes with the same gateway url and ak own separate connections', async () => {
  const firstConnection = new FakeGatewayClient();
  const secondConnection = new FakeGatewayClient();
  let firstConnectCalls = 0;
  let secondConnectCalls = 0;
  firstConnection.connect = async function connect(): Promise<void> {
    firstConnectCalls += 1;
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    await flushEvents();
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };
  secondConnection.connect = async function connect(): Promise<void> {
    secondConnectCalls += 1;
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    await flushEvents();
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };

  const provider: ThirdPartyAgentProvider = {
    async health() {
      return { online: true };
    },
    async createSession() {
      return { toolSessionId: 'tool-1' };
    },
    async runMessage() {
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
  };

  const firstRuntime = await createBridgeRuntime(
    createRuntimeOptions(provider, firstConnection, {
      gatewayHost: {
        url: 'ws://gateway.local',
        auth: {
          ak: 'shared-ak',
          sk: 'shared-sk',
        },
        register: {
          toolType: 'openx',
          toolVersion: '0.0.0',
          pluginVersion: '0.1.0',
        },
      },
      connectionFactory: () => firstConnection,
    }),
  );
  const secondRuntime = await createBridgeRuntime(
    createRuntimeOptions(provider, secondConnection, {
      gatewayHost: {
        url: 'ws://gateway.local',
        auth: {
          ak: 'shared-ak',
          sk: 'shared-sk',
        },
        register: {
          toolType: 'openx',
          toolVersion: '0.0.0',
          pluginVersion: '0.1.0',
        },
      },
      connectionFactory: () => secondConnection,
    }),
  );

  await Promise.all([firstRuntime.start(), secondRuntime.start()]);

  assert.equal(firstConnectCalls, 1);
  assert.equal(secondConnectCalls, 1);
  assert.equal(firstRuntime.getStatus().state, 'ready');
  assert.equal(secondRuntime.getStatus().state, 'ready');
});

test('concurrent start on one runtime creates and connects once', async () => {
  const connection = new FakeGatewayClient();
  let factoryCalls = 0;
  let connectCalls = 0;
  connection.connect = async function connect(): Promise<void> {
    connectCalls += 1;
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    await flushEvents();
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), connection, {
      connectionFactory: () => {
        factoryCalls += 1;
        return connection;
      },
    }),
  );

  await Promise.all([runtime.start(), runtime.start()]);

  assert.equal(factoryCalls, 1);
  assert.equal(connectCalls, 1);
  assert.equal(runtime.getStatus().state, 'ready');
});

test('concurrent probe on one runtime creates one temporary connection', async () => {
  const connection = new FakeGatewayClient();
  let factoryCalls = 0;
  let connectCalls = 0;
  connection.connect = async function connect(): Promise<void> {
    connectCalls += 1;
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    await flushEvents();
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), connection, {
      connectionFactory: () => {
        factoryCalls += 1;
        return connection;
      },
    }),
  );

  const [first, second] = await Promise.all([
    runtime.probe({ timeoutMs: 50 }),
    runtime.probe({ timeoutMs: 50 }),
  ]);

  assert.equal(factoryCalls, 1);
  assert.equal(connectCalls, 1);
  assert.equal(first.state, 'ready');
  assert.deepEqual(second, first);
});

test('start cancels in-flight probe before creating runtime connection', async () => {
  const probeConnection = new FakeGatewayClient();
  const runtimeConnection = new FakeGatewayClient();
  const createdConnections: string[] = [];
  let runtimeConnectCalls = 0;
  probeConnection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
  };
  runtimeConnection.connect = async function connect(): Promise<void> {
    runtimeConnectCalls += 1;
    this.state = 'READY';
    this.emit('stateChange', this.state);
  };
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), runtimeConnection, {
      connectionFactory: () => {
        if (createdConnections.length === 0) {
          createdConnections.push('probe');
          return probeConnection;
        }
        createdConnections.push('runtime');
        return runtimeConnection;
      },
    }),
  );

  const probe = runtime.probe({ timeoutMs: 5_000 });
  await flushEvents();
  await runtime.start();
  const probeResult = await probe;

  assert.deepEqual(createdConnections, ['probe', 'runtime']);
  assert.equal(probeResult.state, 'cancelled');
  assert.equal(runtimeConnectCalls, 1);
  assert.equal(runtime.getStatus().state, 'ready');
});

test('probe waits for connect rejection before classifying startup rejection', async () => {
  const connection = new FakeGatewayClient();
  connection.connect = async function connect(): Promise<void> {
    this.state = 'CONNECTING';
    this.emit('stateChange', this.state);
    this.state = 'DISCONNECTED';
    this.emit('stateChange', this.state);
    throw Object.assign(new Error('gateway_register_rejected'), {
      code: 'GATEWAY_HANDSHAKE_REJECTED',
      disposition: 'startup_failure',
      stage: 'handshake',
      retryable: false,
      message: 'gateway_register_rejected',
    });
  };

  const runtime = await createBridgeRuntime(
    createRuntimeOptions(createProvider(), connection, {
      connectionFactory: () => connection,
    }),
  );

  const result = await runtime.probe({ timeoutMs: 50 });

  assert.deepEqual(result, {
    state: 'rejected',
    latencyMs: result.latencyMs,
    reason: 'gateway_register_rejected',
  });
  assert.equal(result.latencyMs >= 0, true);
});
