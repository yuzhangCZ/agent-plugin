import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EventFilter } from '../../src/event/EventFilter.ts';
import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts';
import { setRuntimeGatewayState } from '../helpers/mock-gateway.mjs';

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'opencode-events');

function createRuntimeClient(overrides = {}) {
  const base = {
    global: {},
    session: {
      create: async () => ({}),
      get: async (options) => ({
        data: {
          id: options?.path?.id ?? 'session-default',
          directory: '/session/default-directory',
        },
      }),
      abort: async () => ({}),
      delete: async () => ({}),
      prompt: async () => ({ data: { ok: true } }),
    },
    _client: {
      get: async (options) => {
        if (options?.url === '/global/health') {
          return { data: { healthy: true, version: '9.9.9' } };
        }
        return { data: [] };
      },
      post: async () => ({ data: undefined }),
    },
  };

  return {
    ...base,
    ...overrides,
    session: {
      ...base.session,
      ...(overrides.session ?? {}),
    },
    _client: {
      ...base._client,
      ...(overrides._client ?? {}),
    },
  };
}

async function loadFixture(fileName) {
  const raw = await readFile(join(FIXTURE_DIR, fileName), 'utf8');
  return JSON.parse(raw);
}

function attach(runtime, opencodeSessionId, anchor = opencodeSessionId) {
  runtime.bindingStore.bind(anchor, opencodeSessionId);
  runtime.ownershipResolver.attach(opencodeSessionId, anchor);
}

describe('protocol question-roundtrip', () => {
  test('forwards question.asked as tool_event and routes question_reply through raw question API', async () => {
    const postCalls = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        _client: {
          get: async (options) => {
            if (options?.url === '/global/health') {
              return { data: { healthy: true, version: '9.9.9' } };
            }
            return { data: [] };
          },
          post: async (options) => {
            postCalls.push(options);
            return { data: undefined };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    runtime.eventFilter = new EventFilter(['question.asked']);
    setRuntimeGatewayState(runtime, 'READY');

    const questionAskedEvent = await loadFixture('question.asked.json');
    attach(runtime, 'ses_question_1');
    await runtime.handleEvent(questionAskedEvent);

    assert.deepStrictEqual(sent, [
      {
        type: 'tool_event',
        toolSessionId: 'ses_question_1',
        event: {
          ...questionAskedEvent,
        },
      },
    ]);

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-question-1',
      action: 'question_reply',
      payload: {
        questionId: 'question_fixture_1',
        answer: 'Vite',
      },
    });

    assert.deepStrictEqual(postCalls, [
      {
        url: '/question/{requestID}/reply',
        path: { requestID: 'question_fixture_1' },
        body: { answers: [['Vite']] },
        headers: { 'Content-Type': 'application/json' },
      },
    ]);
    assert.strictEqual(sent.length, 1);
  });

  test('aggregates child question events under parent and routes question_reply by questionId only', async () => {
    const postCalls = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        _client: {
          get: async (options) => {
            if (options?.url === '/global/health') {
              return { data: { healthy: true, version: '9.9.9' } };
            }
            return { data: [] };
          },
          post: async (options) => {
            postCalls.push(options);
            return { data: undefined };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    runtime.eventFilter = new EventFilter(['question.asked']);
    setRuntimeGatewayState(runtime, 'READY');
    attach(runtime, 'ses_parent_question_1');

    await runtime.handleEvent({
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_child_question_1',
          parentID: 'ses_parent_question_1',
          title: 'planner-agent',
        },
      },
    });

    const questionAskedEvent = {
      type: 'question.asked',
      properties: {
        id: 'question-child-1',
        sessionID: 'ses_child_question_1',
        questions: [],
        tool: {
          messageID: 'msg_child_question_1',
          callID: 'call_child_question_1',
        },
      },
    };
    await runtime.handleEvent(questionAskedEvent);

    assert.deepStrictEqual(sent, [
      {
        type: 'tool_event',
        toolSessionId: 'ses_parent_question_1',
        subagentSessionId: 'ses_child_question_1',
        subagentName: 'planner-agent',
        event: {
          type: 'question.asked',
          properties: {
            id: 'question-child-1',
            sessionID: 'ses_child_question_1',
            tool: {
              messageID: 'msg_child_question_1',
              callID: 'call_child_question_1',
            },
          },
        },
      },
    ]);

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-question-child-1',
      action: 'question_reply',
      payload: {
        questionId: 'question-child-1',
        answer: 'Vite',
      },
    });

    assert.deepStrictEqual(postCalls, [
      {
        url: '/question/{requestID}/reply',
        path: { requestID: 'question-child-1' },
        body: { answers: [['Vite']] },
        headers: { 'Content-Type': 'application/json' },
      },
    ]);
  });

  test('returns tool_error when question_reply transport reports a structured failure', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        _client: {
          get: async (options) => {
            if (options?.url === '/global/health') {
              return { data: { healthy: true, version: '9.9.9' } };
            }
            return { data: [] };
          },
          post: async () => ({
            error: {
              message: 'question reply rejected',
            },
          }),
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-question-ambiguous',
      action: 'question_reply',
      payload: {
        questionId: 'question-direct-1',
        answer: 'Vite',
      },
    });

    assert.deepStrictEqual(sent, [
      {
        type: 'tool_error',
        welinkSessionId: 'wl-question-ambiguous',
        error: 'Failed to reply to question: question reply rejected',
      },
    ]);
  });

  test('returns tool_error when question_reply transport throws', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        _client: {
          get: async (options) => {
            if (options?.url === '/global/health') {
              return { data: { healthy: true, version: '9.9.9' } };
            }
            return { data: [] };
          },
          post: async () => {
            throw new Error('question reply exploded');
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-question-miss',
      action: 'question_reply',
      payload: {
        questionId: 'question-direct-2',
        answer: 'Vite',
      },
    });

    assert.deepStrictEqual(sent, [
      {
        type: 'tool_error',
        welinkSessionId: 'wl-question-miss',
        error: 'Failed to reply to question: question reply exploded',
      },
    ]);
  });
});
