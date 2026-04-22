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
        input: { command: 'ls' },
      },
    },
    {
      type: 'question',
      properties: {
        messageId: 'msg-1',
        partId: 'part-4',
        question: '继续执行吗？',
        toolName: 'question',
        toolCallId: 'call-q-1',
        status: 'running',
        header: '确认操作',
        options: ['是', '否'],
      },
    },
    {
      type: 'permission.ask',
      properties: {
        messageId: 'msg-1',
        partId: 'part-5',
        permissionId: 'perm-1',
        permType: 'file_write',
        toolName: 'write',
        title: '允许写文件',
        metadata: { path: '/tmp/a.ts' },
      },
    },
    {
      type: 'permission.reply',
      properties: {
        permissionId: 'perm-1',
        response: 'once',
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
    { type: 'session.status', properties: { sessionStatus: 'idle', welinkSessionId: 'wl-1' } },
    { type: 'session.error', properties: { error: 'Agent offline', welinkSessionId: 'wl-1' } },
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
      name: 'tool.update invalid status',
      eventType: 'tool.update',
      input: {
        protocol: 'cloud',
        type: 'tool.update',
        properties: {
          messageId: 'msg-1',
          partId: 'part-1',
          toolName: 'bash',
          status: 'queued',
        },
      },
    },
    {
      name: 'session.status missing sessionStatus',
      eventType: 'session.status',
      input: {
        protocol: 'cloud',
        type: 'session.status',
        properties: { welinkSessionId: 'wl-1' },
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
