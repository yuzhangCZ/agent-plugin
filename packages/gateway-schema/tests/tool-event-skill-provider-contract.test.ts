import test from 'node:test';
import assert from 'node:assert/strict';

import { assertWireViolationShape } from '../../test-support/assertions/index.mjs';
import { validateToolEvent } from '../src/index.ts';

test('validateToolEvent accepts all skill provider white-list events', () => {
  const cases = [
    { type: 'text.delta', properties: { messageId: 'msg-1', partId: 'part-1', content: 'he' } },
    { type: 'text.done', properties: { messageId: 'msg-1', partId: 'part-1', content: 'hello' } },
    { type: 'thinking.delta', properties: { messageId: 'msg-1', partId: 'part-2', content: 'th' } },
    { type: 'thinking.done', properties: { messageId: 'msg-1', partId: 'part-2', content: 'thinking' } },
    {
      type: 'tool.update',
      properties: {
        messageId: 'msg-1',
        partId: 'part-3',
        toolName: 'bash',
        status: 'running',
        toolCallId: 'call-1',
        title: 'Execute ls',
        input: 'ls',
        output: 'file-a',
      },
    },
    {
      type: 'question',
      properties: {
        messageId: 'msg-1',
        partId: 'part-4',
        toolCallId: 'call-q-1',
        status: 'running',
        extParam: { scene: 'confirm' },
        questions: [
          {
            question: '继续执行吗？',
            header: '确认操作',
            multiSelect: false,
            options: [{ label: '是' }, { label: '否' }],
          },
        ],
      },
    },
    {
      type: 'permission.ask',
      properties: {
        messageId: 'msg-1',
        partId: 'part-5',
        permissionId: 'perm-1',
        permType: 'file_write',
        title: '允许写文件',
        metadata: { path: '/tmp/a.ts' },
      },
    },
    {
      type: 'permission.reply',
      properties: {
        permissionId: 'perm-1',
        response: 'once',
        permType: 'file_write',
        messageId: 'msg-1',
        partId: 'part-5',
      },
    },
    { type: 'step.start', properties: { messageId: 'msg-1' } },
    {
      type: 'step.done',
      properties: {
        messageId: 'msg-1',
        tokens: { input: 10, output: 20 },
        cost: 0.01,
        reason: 'stop',
      },
    },
    { type: 'session.status', properties: { sessionStatus: 'idle' } },
    { type: 'session.title', properties: { title: '新会话标题' } },
    { type: 'session.error', properties: { error: 'Agent offline' } },
  ] as const;

  for (const item of cases) {
    const result = validateToolEvent({
      protocol: 'cloud',
      type: item.type,
      properties: item.properties,
    });
    assert.equal(result.ok, true, item.type);
    if (!result.ok) {
      continue;
    }

    assert.deepStrictEqual(result.value, {
      protocol: 'cloud',
      type: item.type,
      properties: item.properties,
    });
  }
});

test('validateToolEvent accepts cloud events with deprecated fields that are now stripped from the contract', () => {
  const cases = [
    {
      type: 'permission.ask',
      properties: {
        messageId: 'msg-1',
        partId: 'part-5',
        permissionId: 'perm-1',
        toolName: 'write',
      },
    },
    {
      type: 'question',
      properties: {
        messageId: 'msg-1',
        partId: 'part-4',
        toolName: 'question',
        questions: [
          {
            question: '继续执行吗？',
          },
        ],
      },
    },
    {
      type: 'session.status',
      properties: {
        sessionStatus: 'busy',
        welinkSessionId: 'wl-1',
      },
    },
    {
      type: 'session.error',
      properties: {
        error: 'boom',
        welinkSessionId: 'wl-1',
      },
    },
  ] as const;

  for (const item of cases) {
    const result = validateToolEvent({
      protocol: 'cloud',
      type: item.type,
      properties: item.properties,
    });
    assert.equal(result.ok, true, item.type);
  }
});

test('validateToolEvent rejects skill events outside white-list', () => {
  const cases = [
    'question.ask',
    'permission.replied',
    'session.idle',
    'file',
    'message.user',
    'error',
    'snapshot',
    'streaming',
    'planning.delta',
    'planning.done',
    'searching',
    'search_result',
    'reference',
    'ask_more',
    'message.start',
    'message.done',
  ] as const;

  for (const eventType of cases) {
    const result = validateToolEvent({
      protocol: 'cloud',
      type: eventType,
      properties: {},
    });
    assert.equal(result.ok, false, eventType);
    if (result.ok) {
      continue;
    }

    assertWireViolationShape(result.error, {
      stage: 'event',
      field: 'type',
      eventType,
    });
  }
});

test('validateToolEvent fail-closes malformed skill events', () => {
  const malformedCases: Array<{ name: string; input: unknown; eventType: string }> = [
    {
      name: 'permission.reply missing response',
      eventType: 'permission.reply',
      input: {
        protocol: 'cloud',
        type: 'permission.reply',
        properties: { permissionId: 'perm-1' },
      },
    },
    {
      name: 'tool.update missing toolCallId',
      eventType: 'tool.update',
      input: {
        protocol: 'cloud',
        type: 'tool.update',
        properties: {
          messageId: 'msg-1',
          partId: 'part-1',
          toolName: 'bash',
          status: 'running',
        },
      },
    },
    {
      name: 'tool.update non-string input',
      eventType: 'tool.update',
      input: {
        protocol: 'cloud',
        type: 'tool.update',
        properties: {
          messageId: 'msg-1',
          partId: 'part-1',
          toolName: 'bash',
          status: 'running',
          toolCallId: 'call-1',
          input: { command: 'ls' },
        },
      },
    },
    {
      name: 'question missing questions',
      eventType: 'question',
      input: {
        protocol: 'cloud',
        type: 'question',
        properties: {
          messageId: 'msg-1',
          partId: 'part-4',
        },
      },
    },
    {
      name: 'question flat payload is rejected',
      eventType: 'question',
      input: {
        protocol: 'cloud',
        type: 'question',
        properties: {
          messageId: 'msg-1',
          partId: 'part-4',
          question: '继续执行吗？',
          options: [{ label: '是' }],
        },
      },
    },
    {
      name: 'question string options are rejected',
      eventType: 'question',
      input: {
        protocol: 'cloud',
        type: 'question',
        properties: {
          messageId: 'msg-1',
          partId: 'part-4',
          questions: [
            {
              question: '继续执行吗？',
              options: ['是', '否'],
            },
          ],
        },
      },
    },
    {
      name: 'question top-level multiSelect is rejected',
      eventType: 'question',
      input: {
        protocol: 'cloud',
        type: 'question',
        properties: {
          messageId: 'msg-1',
          partId: 'part-4',
          multiSelect: true,
          questions: [
            {
              question: '继续执行吗？',
            },
          ],
        },
      },
    },
    {
      name: 'step.done tokens must be numeric map',
      eventType: 'step.done',
      input: {
        protocol: 'cloud',
        type: 'step.done',
        properties: {
          messageId: 'msg-1',
          tokens: { input: '10' },
        },
      },
    },
    {
      name: 'session.status missing sessionStatus',
      eventType: 'session.status',
      input: {
        protocol: 'cloud',
        type: 'session.status',
        properties: {},
      },
    },
    {
      name: 'session.status invalid status value',
      eventType: 'session.status',
      input: {
        protocol: 'cloud',
        type: 'session.status',
        properties: { sessionStatus: 'waiting' },
      },
    },
    {
      name: 'session.title missing title',
      eventType: 'session.title',
      input: {
        protocol: 'cloud',
        type: 'session.title',
        properties: {},
      },
    },
  ];

  for (const testCase of malformedCases) {
    const result = validateToolEvent(testCase.input);
    assert.equal(result.ok, false, testCase.name);
    if (result.ok) {
      continue;
    }
    assertWireViolationShape(result.error, {
      stage: 'event',
      eventType: testCase.eventType,
    });
  }
});
