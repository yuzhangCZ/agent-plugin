import assert from 'node:assert/strict';
import test from 'node:test';

import { DefaultFactToSkillEventProjector } from '@/application/projectors/index.ts';

test('DefaultFactToSkillEventProjector maps message lifecycle and text facts into skill events', () => {
  const projector = new DefaultFactToSkillEventProjector();

  assert.deepEqual(projector.project({ type: 'message.start', messageId: 'msg-1' }), [{
    protocol: 'cloud',
    type: 'step.start',
    properties: { messageId: 'msg-1', extParameters: undefined },
  }]);
  assert.deepEqual(projector.project({
    type: 'text.delta',
    messageId: 'msg-1',
    partId: 'part-1',
    content: 'hello',
  }), [{
    protocol: 'cloud',
    type: 'text.delta',
    properties: {
      messageId: 'msg-1',
      partId: 'part-1',
      content: 'hello',
      extParameters: undefined,
    },
  }]);
  assert.deepEqual(projector.project({
    type: 'message.done',
    messageId: 'msg-1',
    reason: 'stop',
    tokens: { input: 1, output: 2 },
    cost: 0.1,
  }), [{
    protocol: 'cloud',
    type: 'step.done',
    properties: {
      messageId: 'msg-1',
      tokens: { input: 1, output: 2 },
      cost: 0.1,
      reason: 'stop',
      extParameters: undefined,
    },
  }]);
});

test('DefaultFactToSkillEventProjector maps interaction facts with compatibility fields', () => {
  const projector = new DefaultFactToSkillEventProjector();

  assert.deepEqual(projector.project({
    type: 'question.ask',
    messageId: 'msg-1',
    partId: 'part-1',
    questionId: 'question-1',
    questions: [{ question: 'Continue?', options: [{ label: 'Yes' }], multiSelect: false }],
  }), [{
    protocol: 'cloud',
    type: 'question',
    properties: {
      messageId: 'msg-1',
      partId: 'part-1',
      questionId: 'question-1',
      toolCallId: 'question-1',
      extParameters: undefined,
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }], multiSelect: false }],
    },
  }]);
  assert.deepEqual(projector.project({
    type: 'permission.ask',
    partId: 'part-2',
    permissionId: 'permission-1',
    permType: 'shell',
  }), [{
    protocol: 'cloud',
    type: 'permission.ask',
    properties: {
      partId: 'part-2',
      permissionId: 'permission-1',
      permType: 'shell',
      title: '',
      extParameters: undefined,
    },
  }]);
});

test('DefaultFactToSkillEventProjector maps fact extParameters into skill event properties', () => {
  const projector = new DefaultFactToSkillEventProjector();
  const extParameters = { requestId: 'ext-fact-1', nested: { enabled: true } };
  const cases = [
    { type: 'message.start', messageId: 'msg-1', extParameters },
    { type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: 'hello', extParameters },
    { type: 'text.done', messageId: 'msg-1', partId: 'part-1', content: 'hello', extParameters },
    { type: 'thinking.delta', messageId: 'msg-1', partId: 'part-2', content: 'thinking', extParameters },
    { type: 'thinking.done', messageId: 'msg-1', partId: 'part-2', content: 'thinking', extParameters },
    {
      type: 'tool.update',
      messageId: 'msg-1',
      partId: 'part-3',
      toolCallId: 'call-1',
      toolName: 'bash',
      status: 'running',
      extParameters,
    },
    {
      type: 'question.ask',
      messageId: 'msg-1',
      partId: 'part-4',
      questionId: 'question-1',
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      extParameters,
    },
    { type: 'permission.ask', partId: 'part-5', permissionId: 'perm-1', permType: 'shell', extParameters },
    { type: 'permission.reply', permissionId: 'perm-1', response: 'once', extParameters },
    { type: 'message.done', messageId: 'msg-1', extParameters },
    { type: 'session.title', title: 'New session', extParameters },
    { type: 'session.error', error: { code: 'provider_error', message: 'offline' }, extParameters },
  ] as const;

  for (const fact of cases) {
    const events = projector.project(fact as never);
    assert.equal(events.length, 1, fact.type);
    assert.deepEqual(events[0]?.properties.extParameters, extParameters, fact.type);
  }
});

test('DefaultFactToSkillEventProjector keeps absent fact extParameters as undefined after direct assignment', () => {
  const projector = new DefaultFactToSkillEventProjector();

  assert.deepEqual(projector.project({
    type: 'text.done',
    messageId: 'msg-1',
    partId: 'part-1',
    content: 'hello',
  }), [{
    protocol: 'cloud',
    type: 'text.done',
    properties: {
      messageId: 'msg-1',
      partId: 'part-1',
      content: 'hello',
      extParameters: undefined,
    },
  }]);
});
