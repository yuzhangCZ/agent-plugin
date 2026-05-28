import test from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryPendingInteractionRegistry } from '../src/infrastructure/registries/InMemoryPendingInteractionRegistry.ts';
import { InMemorySessionRuntimeRegistry } from '../src/infrastructure/registries/InMemorySessionRuntimeRegistry.ts';

test('session runtime registry coordinates request run and outbound emission independently', () => {
  const registry = new InMemorySessionRuntimeRegistry();

  const seeded = registry.ensure({ toolSessionId: 'tool-1', welinkSessionId: 'we-1' });
  assert.equal(seeded.toolSessionId, 'tool-1');
  assert.equal(seeded.welinkSessionId, 'we-1');
  assert.deepEqual(seeded.requestRun, { status: 'idle' });
  assert.deepEqual(seeded.outbound, { status: 'idle' });
  assert.deepEqual(registry.getRequestRunState('missing-tool'), { status: 'idle' });
  assert.equal(registry.getActiveRequestRunId('missing-tool'), undefined);
  assert.deepEqual(registry.getOutboundEmissionState('missing-tool'), { status: 'idle' });

  const runAcquired = registry.acquireRequestRun('tool-1', 'run-1');
  assert.equal(runAcquired.ok, true);
  assert.deepEqual(registry.getRequestRunState('tool-1'), { status: 'running', runId: 'run-1' });
  assert.equal(registry.getActiveRequestRunId('tool-1'), 'run-1');
  assert.equal(registry.acquireRequestRun('tool-1', 'run-2').ok, false);
  registry.releaseRequestRun('tool-1', 'run-2');
  assert.deepEqual(registry.getRequestRunState('tool-1'), { status: 'running', runId: 'run-1' });

  const outboundAcquired = registry.acquireOutboundEmission('tool-1', 'msg-1');
  assert.equal(outboundAcquired.ok, true);
  assert.deepEqual(registry.getOutboundEmissionState('tool-1'), { status: 'emitting', messageId: 'msg-1' });
  assert.equal(registry.acquireOutboundEmission('tool-1', 'msg-2').ok, false);
  registry.releaseOutboundEmission('tool-1', 'msg-2');
  assert.deepEqual(registry.getOutboundEmissionState('tool-1'), { status: 'emitting', messageId: 'msg-1' });
  assert.deepEqual(registry.getRequestRunState('tool-1'), { status: 'running', runId: 'run-1' });

  assert.equal(registry.acquireRequestRun('tool-2', 'run-3').ok, true);
  registry.releaseRequestRun('tool-1', 'run-1');
  registry.releaseOutboundEmission('tool-1', 'msg-1');
  assert.deepEqual(registry.getRequestRunState('tool-1'), { status: 'idle' });
  assert.equal(registry.getActiveRequestRunId('tool-1'), undefined);
  assert.deepEqual(registry.getOutboundEmissionState('tool-1'), { status: 'idle' });
});

test('session runtime registry delete only clears local coordination cache', () => {
  const registry = new InMemorySessionRuntimeRegistry();

  registry.ensure({ toolSessionId: 'tool-1', welinkSessionId: 'we-1' });
  assert.equal(registry.acquireRequestRun('tool-1', 'run-1').ok, true);
  registry.delete('tool-1');

  assert.equal(registry.get('tool-1'), undefined);
  const recreated = registry.ensure({ toolSessionId: 'tool-1' });
  assert.deepEqual(recreated.requestRun, { status: 'idle' });
  assert.deepEqual(recreated.outbound, { status: 'idle' });
});

test('session runtime registry preserves seeded welinkSessionId across later ensures without the field', () => {
  const registry = new InMemorySessionRuntimeRegistry();

  registry.ensure({ toolSessionId: 'tool-1', welinkSessionId: 'we-1' });
  const preserved = registry.ensure({ toolSessionId: 'tool-1' });

  assert.equal(preserved.welinkSessionId, 'we-1');
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
