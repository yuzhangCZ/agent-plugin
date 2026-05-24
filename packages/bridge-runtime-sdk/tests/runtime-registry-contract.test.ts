import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryPendingInteractionRegistry,
  InMemorySessionRuntimeRegistry,
} from '../src/infrastructure/InMemoryRegistries.ts';

test('session runtime registry enforces active run/outbound coordination and closed session rejection', () => {
  const registry = new InMemorySessionRuntimeRegistry();

  const seeded = registry.ensure({ toolSessionId: 'tool-1', welinkSessionId: 'we-1' });
  assert.equal(seeded.toolSessionId, 'tool-1');
  assert.equal(seeded.welinkSessionId, 'we-1');
  assert.equal(seeded.lifecycle, 'active');

  const runAcquired = registry.acquireActiveRun('tool-1', 'run-1');
  assert.equal(runAcquired.ok, true);
  assert.equal(registry.acquireActiveRun('tool-1', 'run-2').ok, false);
  registry.releaseActiveRun('tool-1', 'run-2');
  assert.equal(registry.get('tool-1')?.activeRunId, 'run-1');
  registry.releaseActiveRun('tool-1', 'run-1');
  assert.equal(registry.get('tool-1')?.activeRunId, undefined);

  const outboundAcquired = registry.acquireActiveOutbound('tool-1', 'msg-1');
  assert.equal(outboundAcquired.ok, true);
  assert.equal(registry.acquireActiveOutbound('tool-1', 'msg-2').ok, false);
  registry.releaseActiveOutbound('tool-1', 'msg-2');
  assert.equal(registry.get('tool-1')?.activeOutboundMessageId, 'msg-1');
  registry.releaseActiveOutbound('tool-1', 'msg-1');
  assert.equal(registry.get('tool-1')?.activeOutboundMessageId, undefined);

  registry.markClosed('tool-1');
  assert.equal(registry.acquireActiveRun('tool-1', 'run-3').ok, false);
  assert.equal(registry.acquireActiveOutbound('tool-1', 'msg-3').ok, false);
});

test('pending interaction registry enforces global token uniqueness and session clearing', () => {
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
  registry.clearSession('tool-1');
  assert.equal(registry.consume({ kind: 'permission', tokenId: 'perm-1' }), undefined);
});
