import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRequestRunPolicy } from '@/application/request-run-policy.ts';

test('request run policy defaults only when config or field is absent', () => {
  assert.deepEqual(resolveRequestRunPolicy(), { activeRunChatPolicy: 'reject' });
  assert.deepEqual(resolveRequestRunPolicy({}), { activeRunChatPolicy: 'reject' });
  assert.deepEqual(resolveRequestRunPolicy({ activeRunChatPolicy: undefined }), { activeRunChatPolicy: 'reject' });
});

test('request run policy rejects explicit invalid dynamic values', () => {
  assert.throws(
    () => resolveRequestRunPolicy({ activeRunChatPolicy: null as never }),
    {
      name: 'TypeError',
      message: 'Invalid activeRunChatPolicy: null',
    },
  );
  assert.throws(
    () => resolveRequestRunPolicy({ activeRunChatPolicy: 'drop' as never }),
    {
      name: 'TypeError',
      message: 'Invalid activeRunChatPolicy: drop',
    },
  );
});
