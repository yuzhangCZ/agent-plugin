import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryPermissionPresentationRegistry } from '@/infrastructure/registries/InMemoryPermissionPresentationRegistry.ts';

test('permission presentation registry stores, retrieves, and clears presentation context by session and permission id', () => {
  const registry = new InMemoryPermissionPresentationRegistry();
  const record = {
    toolSessionId: 'tool-1',
    permissionId: 'permission-1',
    partId: 'part-1',
    messageId: 'msg-1',
    permType: 'shell',
    subagentSessionId: 'subagent-1',
  };

  assert.deepEqual(registry.register(record), { ok: true, status: 'inserted' });
  assert.deepEqual(registry.get('tool-1', 'permission-1'), record);
  registry.clearSession('tool-1');
  assert.equal(registry.get('tool-1', 'permission-1'), undefined);
});

test('permission presentation registry treats duplicate permission id in the same session as idempotent', () => {
  const registry = new InMemoryPermissionPresentationRegistry();
  const first = {
    toolSessionId: 'tool-1',
    permissionId: 'permission-1',
    partId: 'part-1',
    permType: 'shell',
  };
  const duplicate = {
    toolSessionId: 'tool-1',
    permissionId: 'permission-1',
    partId: 'part-2',
    permType: 'filesystem',
  };

  assert.deepEqual(registry.register(first), { ok: true, status: 'inserted' });
  assert.deepEqual(registry.register(duplicate), { ok: true, status: 'duplicate_same_permission' });
  assert.deepEqual(registry.get('tool-1', 'permission-1'), first);
});
