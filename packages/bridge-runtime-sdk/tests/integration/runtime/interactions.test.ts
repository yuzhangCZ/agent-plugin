import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDownstream } from '@agent-plugin/gateway-schema';
import { createBridgeRuntime } from '@/index.ts';
import { createFakeRun, createProvider, createRuntimeOptions, FakeGatewayClient, flushEvents } from '../support/runtime-harness.ts';

test('runtime consumes legacy question answer by questionId and forwards normalized answers', async () => {
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
                    options: [{ label: 'A', description: 'First option' }, { label: 'B' }],
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
  const legacyQuestionReply = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: { questionId: 'question-1', answer: 'A' },
  });
  assert.equal(legacyQuestionReply.ok, true);
  connection.emitMessage(legacyQuestionReply.value);
  await flushEvents();

  assert.deepEqual(capturedQuestionReply, {
    traceId: 'trace-fixed',
    questionId: 'question-1',
    answers: [['A']],
    extParameters: undefined,
  });
});

test('runtime forwards structured question replies without flattening answers', async () => {
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
                questions: [
                  { question: 'Pick one', options: [{ label: 'A' }] },
                  { question: 'Pick many', options: [{ label: 'B' }, { label: 'C' }] },
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
    payload: { questionId: 'question-1', answers: [['A'], ['B', 'C']] },
  });
  await flushEvents();

  assert.deepEqual(capturedQuestionReply, {
    traceId: 'trace-fixed',
    questionId: 'question-1',
    answers: [['A'], ['B', 'C']],
    extParameters: undefined,
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
                permType: 'file_write',
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
    extParameters: undefined,
  });
});

test('close_session preserves pending question reply token routing', async () => {
  const connection = new FakeGatewayClient();
  const repliedQuestionIds: string[] = [];
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
                questionId: 'question-close-1',
                questions: [{ question: 'Proceed?' }],
              },
              { type: 'message.done', messageId: 'msg-1' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion(input) {
          repliedQuestionIds.push(input.questionId);
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
    action: 'close_session',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    payload: { questionId: 'question-close-1', answers: [['yes']] },
  });
  await flushEvents();

  assert.deepEqual(repliedQuestionIds, ['question-close-1']);
});

test('close_session preserves pending permission reply token routing', async () => {
  const connection = new FakeGatewayClient();
  const repliedPermissionIds: string[] = [];
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
                permissionId: 'permission-close-1',
                permType: 'file_write',
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
          repliedPermissionIds.push(input.permissionId);
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
    action: 'close_session',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-close-1', response: 'always' },
  });
  await flushEvents();

  assert.deepEqual(repliedPermissionIds, ['permission-close-1']);
});

test('question_reply missing pending interaction projects tool_error', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    welinkSessionId: 'welink-question-missing-1',
    payload: { questionId: 'question-missing-1', answers: [['A']] },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
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
    error: '当前交互已失效，请刷新后重试',
  });
});
