import assert from 'node:assert/strict';
import test from 'node:test';

import { RequestRunFailureToolErrorProjector } from '@/application/projectors/RequestRunFailureToolErrorProjector.ts';
import { ToolErrorMessageCatalog } from '@/application/projectors/ToolErrorMessageCatalog.ts';

test('RequestRunFailureToolErrorProjector emits request_run_failed tool_error for active run lifecycle failures', () => {
  const projector = new RequestRunFailureToolErrorProjector(new ToolErrorMessageCatalog());

  assert.deepEqual(projector.project({ toolSessionId: 'tool-1' }), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: '当前请求处理失败，请重试',
  });
});
