import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryPendingInteractionRegistry } from '@/infrastructure/registries/InMemoryPendingInteractionRegistry.ts';

test('pending interaction registry enforces global token uniqueness and exact token consumption', () => {
  const registry = new InMemoryPendingInteractionRegistry();

  assert.deepEqual(registry.register({
    toolSessionId: 'tool-1',
    kind: 'question',
    tokenId: 'token-1',
    messageId: 'msg-1',
  }), { ok: true });

  assert.deepEqual(registry.register({
    toolSessionId: 'tool-1',
    kind: 'question',
    tokenId: 'token-1',
  }), { ok: false, reason: 'duplicate_same_session' });

  const conflict = registry.register({
    toolSessionId: 'tool-2',
    kind: 'question',
    tokenId: 'token-1',
  });
  assert.equal(conflict.ok, false);
  if (conflict.ok) {
    assert.fail('expected cross-session conflict');
  }
  assert.equal(conflict.reason, 'conflict_cross_session');
  assert.equal(conflict.conflict.existing.toolSessionId, 'tool-1');
  assert.equal(conflict.conflict.current.toolSessionId, 'tool-2');

  assert.deepEqual(registry.consume({ kind: 'question', tokenId: 'token-1' }), {
    toolSessionId: 'tool-1',
    kind: 'question',
    tokenId: 'token-1',
    messageId: 'msg-1',
  });
  assert.equal(registry.consume({ kind: 'question', tokenId: 'token-1' }), undefined);

  assert.deepEqual(registry.register({
    toolSessionId: 'tool-1',
    kind: 'permission',
    tokenId: 'perm-1',
  }), { ok: true });
  assert.deepEqual(registry.register({
    toolSessionId: 'tool-1',
    kind: 'permission',
    tokenId: 'perm-2',
  }), { ok: true });
  assert.deepEqual(registry.consume({ kind: 'permission', tokenId: 'perm-1' }), {
    toolSessionId: 'tool-1',
    kind: 'permission',
    tokenId: 'perm-1',
  });
  assert.deepEqual(registry.consume({ kind: 'permission', tokenId: 'perm-2' }), {
    toolSessionId: 'tool-1',
    kind: 'permission',
    tokenId: 'perm-2',
  });
});
