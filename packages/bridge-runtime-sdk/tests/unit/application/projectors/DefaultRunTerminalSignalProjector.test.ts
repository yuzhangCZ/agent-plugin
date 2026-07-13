import assert from 'node:assert/strict';
import test from 'node:test';

import { DefaultRunTerminalSignalProjector } from '@/application/projectors/index.ts';

test('DefaultRunTerminalSignalProjector maps completed and aborted result to tool_done', () => {
  const projector = new DefaultRunTerminalSignalProjector();

  assert.deepEqual(projector.project({
    toolSessionId: 'tool-1',
    result: { outcome: 'completed' },
  }), {
    type: 'tool_done',
    toolSessionId: 'tool-1',
  });
  assert.deepEqual(projector.project({
    toolSessionId: 'tool-1',
    result: { outcome: 'aborted' },
  }), {
    type: 'tool_done',
    toolSessionId: 'tool-1',
  });
});

test('DefaultRunTerminalSignalProjector maps failed result to tool_error with optional stale-session reason', () => {
  const projector = new DefaultRunTerminalSignalProjector();

  assert.deepEqual(projector.project({
    toolSessionId: 'tool-1',
    result: { outcome: 'failed', error: { code: 'provider_failed', message: 'provider failed' } },
  }), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: 'provider failed',
  });
  assert.deepEqual(projector.project({
    toolSessionId: 'tool-1',
    result: { outcome: 'failed', error: { code: 'session_not_found', message: 'session missing' } },
  }), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: 'session missing',
    reason: 'session_not_found',
  });
});
