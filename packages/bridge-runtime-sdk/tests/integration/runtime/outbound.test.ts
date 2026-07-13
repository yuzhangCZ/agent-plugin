import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeRuntime } from '@/index.ts';
import type { ProviderRuntimeContext } from '@/index.ts';
import {
  createAsyncFacts,
  createDeferred,
  createFakeRun,
  createHangingFacts,
  createProvider,
  createRuntimeOptions,
  FakeGatewayClient,
  flushEvents,
} from '../support/runtime-harness.ts';

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

test('emitOutboundRun projects multiple assistant messages in one outbound stream', async () => {
  const connection = new FakeGatewayClient();
  const provider = createProvider();
  let outbound: ProviderRuntimeContext['outbound'];
  provider.initialize = async (context) => {
    outbound = context.outbound;
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  await outbound.emitOutboundRun({
    toolSessionId: 'tool-outbound-run-1',
    runId: 'outbound-run-1',
    trigger: 'system',
    facts: createAsyncFacts([
      { type: 'message.start', messageId: 'msg-1' },
      { type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: 'hello' },
      { type: 'message.done', messageId: 'msg-1' },
      { type: 'message.start', messageId: 'msg-2' },
      { type: 'text.delta', messageId: 'msg-2', partId: 'part-2', content: 'again' },
      { type: 'message.done', messageId: 'msg-2' },
    ]),
  });
  await flushEvents();

  assert.deepEqual(connection.sent.slice(-7), [
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'step.start',
        properties: { messageId: 'msg-1' },
      },
    },
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'text.delta',
        properties: { messageId: 'msg-1', partId: 'part-1', content: 'hello' },
      },
    },
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'step.done',
        properties: { messageId: 'msg-1' },
      },
    },
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'step.start',
        properties: { messageId: 'msg-2' },
      },
    },
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'text.delta',
        properties: { messageId: 'msg-2', partId: 'part-2', content: 'again' },
      },
    },
    {
      type: 'tool_event',
      toolSessionId: 'tool-outbound-run-1',
      event: {
        protocol: 'cloud',
        type: 'step.done',
        properties: { messageId: 'msg-2' },
      },
    },
    {
      type: 'tool_done',
      toolSessionId: 'tool-outbound-run-1',
    },
  ]);
});

test('emitOutboundRun emits tool_error when facts fail validation', async () => {
  const connection = new FakeGatewayClient();
  const provider = createProvider();
  let outbound: ProviderRuntimeContext['outbound'];
  provider.initialize = async (context) => {
    outbound = context.outbound;
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  await assert.rejects(
    () => outbound.emitOutboundRun({
      toolSessionId: 'tool-outbound-run-invalid',
      runId: 'outbound-run-invalid',
      trigger: 'system',
      facts: createAsyncFacts([
        { type: 'text.delta', messageId: 'msg-invalid', partId: 'part-invalid', content: 'orphan' },
      ]),
    }),
    (error) => error instanceof Error && 'code' in error && error.code === 'fact_sequence_invalid',
  );
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-outbound-run-invalid',
    error: 'text.delta requires an open message',
  });
  assert.deepEqual(runtime.getDiagnostics().terminals.at(-1), {
    toolSessionId: 'tool-outbound-run-invalid',
    outcome: 'failed',
  });
});

test('outbound run and outbound message are mutually exclusive per tool session', async () => {
  const connection = new FakeGatewayClient();
  const provider = createProvider();
  let outbound: ProviderRuntimeContext['outbound'];
  provider.initialize = async (context) => {
    outbound = context.outbound;
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));
  const releaseRun = createDeferred<void>();

  await runtime.start();
  const activeRun = outbound.emitOutboundRun({
    toolSessionId: 'tool-outbound-lock-1',
    runId: 'outbound-run-lock-1',
    trigger: 'system',
    facts: createHangingFacts([
      { type: 'message.start', messageId: 'msg-lock-1' },
    ], releaseRun.promise),
  });
  await flushEvents();

  await assert.rejects(
    () => outbound.emitOutboundMessage({
      toolSessionId: 'tool-outbound-lock-1',
      messageId: 'msg-lock-conflict-1',
      trigger: 'system',
      facts: createAsyncFacts([{ type: 'session.error', error: { message: 'busy' } }]),
    }),
    (error) => error instanceof Error && 'code' in error && error.code === 'outbound_already_active',
  );

  releaseRun.resolve();
  await activeRun;

  const releaseMessage = createDeferred<void>();
  const activeMessage = outbound.emitOutboundMessage({
    toolSessionId: 'tool-outbound-lock-1',
    messageId: 'msg-lock-active-1',
    trigger: 'system',
    facts: createHangingFacts([
      { type: 'message.start', messageId: 'msg-lock-active-1' },
    ], releaseMessage.promise),
  });
  await flushEvents();

  await assert.rejects(
    () => outbound.emitOutboundRun({
      toolSessionId: 'tool-outbound-lock-1',
      runId: 'outbound-run-conflict-1',
      trigger: 'system',
      facts: createAsyncFacts([{ type: 'message.start', messageId: 'msg-lock-conflict-2' }]),
    }),
    (error) => error instanceof Error && 'code' in error && error.code === 'outbound_already_active',
  );

  releaseMessage.resolve();
  await activeMessage;
});
