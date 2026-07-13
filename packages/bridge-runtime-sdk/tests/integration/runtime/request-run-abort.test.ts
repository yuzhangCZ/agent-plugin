import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeRuntime } from '@/index.ts';
import type { ProviderTerminalResult } from '@/index.ts';
import {
  createAsyncFacts,
  createDeferred,
  createFakeRun,
  createProvider,
  createRuntimeOptions,
  FakeGatewayClient,
  flushEvents,
} from '../support/runtime-harness.ts';

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
    error: '当前会话正在处理中，请稍后再试',
  });
  firstRunResult.resolve({ outcome: 'completed' });
  await flushEvents();
});
