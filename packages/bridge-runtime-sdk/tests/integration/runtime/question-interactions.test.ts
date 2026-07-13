import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeRuntime } from '@/index.ts';
import { createFakeRun, createRuntimeOptions, FakeGatewayClient, flushEvents } from '../support/runtime-harness.ts';

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
                    options: [{ label: 'A', description: 'First option' }, { label: 'B' }],
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
            options: [{ label: 'A', description: 'First option' }, { label: 'B' }],
            multiSelect: true,
          },
        ],
      },
    },
  });
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
    payload: { questionId: 'question-1', answers: [['A']] },
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

test('question.ask rejects globally duplicated questionId across sessions without clearing pending interactions', async () => {
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
                partId: 'part-question-current',
                questionId: 'question-current',
                questions: [{ question: 'Current question' }],
              },
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
    payload: { questionId: 'question-dup', answers: [['A']] },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'question_reply',
    payload: { questionId: 'question-current', answers: [['B']] },
  });
  await flushEvents();

  assert.deepEqual(repliedQuestionIds, ['question-dup', 'question-current']);
  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(connection.sent.findLast((message) => {
    return typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'tool_error'
      && 'toolSessionId' in message
      && message.toolSessionId === 'tool-2';
  }), {
    type: 'tool_error',
    toolSessionId: 'tool-2',
    error: '当前请求处理失败，请重试',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'question interaction reply target must be globally unique',
    code: 'pending_interaction_conflict',
  });
});
