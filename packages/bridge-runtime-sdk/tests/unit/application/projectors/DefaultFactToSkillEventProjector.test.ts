import assert from 'node:assert/strict';
import test from 'node:test';

import { DefaultFactToSkillEventProjector } from '@/application/projectors/index.ts';

test('DefaultFactToSkillEventProjector maps message lifecycle and text facts into skill events', () => {
  const projector = new DefaultFactToSkillEventProjector();

  assert.deepEqual(projector.project({ type: 'message.start', messageId: 'msg-1' }), [{
    protocol: 'cloud',
    type: 'step.start',
    properties: { messageId: 'msg-1' },
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
    },
  }]);
});
