import assert from 'node:assert/strict';
import test from 'node:test';

import { DefaultSkillEventToGatewayMessageProjector } from '@/application/projectors/index.ts';

test('DefaultSkillEventToGatewayMessageProjector wraps skill events in gateway tool_event messages', () => {
  const projector = new DefaultSkillEventToGatewayMessageProjector();
  const event = {
    protocol: 'cloud',
    type: 'text.delta',
    properties: { messageId: 'msg-1', partId: 'part-1', content: 'hello' },
  } as never;

  assert.deepEqual(projector.project('tool-1', event, {
    subagentSessionId: 'subagent-session-1',
    subagentName: 'coder',
  }), {
    type: 'tool_event',
    toolSessionId: 'tool-1',
    subagentSessionId: 'subagent-session-1',
    subagentName: 'coder',
    event,
  });
});
