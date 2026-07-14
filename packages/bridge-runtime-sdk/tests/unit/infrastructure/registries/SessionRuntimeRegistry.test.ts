import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemorySessionRuntimeRegistry } from '@/infrastructure/registries/InMemorySessionRuntimeRegistry.ts';

test('session runtime registry coordinates request run and outbound emission independently', () => {
  const registry = new InMemorySessionRuntimeRegistry();

  const seeded = registry.ensure({ toolSessionId: 'tool-1', welinkSessionId: 'we-1' });
  assert.equal(seeded.toolSessionId, 'tool-1');
  assert.equal(seeded.welinkSessionId, 'we-1');
  assert.deepEqual(seeded.requestRun, { activeRunIds: [] });
  assert.deepEqual(seeded.outbound, { status: 'idle' });
  assert.deepEqual(registry.getRequestRunState('missing-tool'), { activeRunIds: [] });
  assert.deepEqual(registry.getOutboundEmissionState('missing-tool'), { status: 'idle' });

  assert.deepEqual(registry.registerRequestRun('tool-1', 'run-1'), { activeRunIds: ['run-1'] });
  assert.deepEqual(registry.getRequestRunState('tool-1'), { activeRunIds: ['run-1'] });
  assert.deepEqual(registry.registerRequestRun('tool-1', 'run-1'), { activeRunIds: ['run-1'] });
  assert.deepEqual(registry.registerRequestRun('tool-1', 'run-2'), { activeRunIds: ['run-1', 'run-2'] });
  assert.deepEqual(registry.releaseRequestRun('tool-1', 'run-missing'), { activeRunIds: ['run-1', 'run-2'] });

  const outboundAcquired = registry.acquireOutboundEmission('tool-1', 'msg-1');
  assert.equal(outboundAcquired.ok, true);
  assert.deepEqual(registry.getOutboundEmissionState('tool-1'), { status: 'emitting', messageId: 'msg-1' });
  assert.equal(registry.acquireOutboundEmission('tool-1', 'msg-2').ok, false);
  registry.releaseOutboundEmission('tool-1', 'msg-2');
  assert.deepEqual(registry.getOutboundEmissionState('tool-1'), { status: 'emitting', messageId: 'msg-1' });
  assert.deepEqual(registry.getRequestRunState('tool-1'), { activeRunIds: ['run-1', 'run-2'] });

  assert.deepEqual(registry.registerRequestRun('tool-2', 'run-3'), { activeRunIds: ['run-3'] });
  assert.deepEqual(registry.releaseRequestRun('tool-1', 'run-1'), { activeRunIds: ['run-2'] });
  assert.deepEqual(registry.releaseRequestRun('tool-1', 'run-2'), { activeRunIds: [] });
  registry.releaseOutboundEmission('tool-1', 'msg-1');
  assert.deepEqual(registry.getRequestRunState('tool-1'), { activeRunIds: [] });
  assert.deepEqual(registry.getOutboundEmissionState('tool-1'), { status: 'idle' });
});

test('session runtime registry delete only clears local coordination cache', () => {
  const registry = new InMemorySessionRuntimeRegistry();

  registry.ensure({ toolSessionId: 'tool-1', welinkSessionId: 'we-1' });
  assert.deepEqual(registry.registerRequestRun('tool-1', 'run-1'), { activeRunIds: ['run-1'] });
  registry.delete('tool-1');

  assert.equal(registry.get('tool-1'), undefined);
  const recreated = registry.ensure({ toolSessionId: 'tool-1' });
  assert.deepEqual(recreated.requestRun, { activeRunIds: [] });
  assert.deepEqual(recreated.outbound, { status: 'idle' });
});

test('session runtime registry returns request run snapshots that cannot mutate internal state', () => {
  const registry = new InMemorySessionRuntimeRegistry();

  const registered = registry.registerRequestRun('tool-1', 'run-1') as { activeRunIds: string[] };
  registered.activeRunIds.push('run-mutated');

  assert.deepEqual(registry.getRequestRunState('tool-1'), { activeRunIds: ['run-1'] });

  const current = registry.getRequestRunState('tool-1') as { activeRunIds: string[] };
  current.activeRunIds.push('run-mutated-again');

  assert.deepEqual(registry.getRequestRunState('tool-1'), { activeRunIds: ['run-1'] });
});

test('session runtime registry ensure returns records that cannot mutate internal request run state', () => {
  const registry = new InMemorySessionRuntimeRegistry();

  registry.registerRequestRun('tool-1', 'run-1');
  const ensured = registry.ensure({ toolSessionId: 'tool-1' });
  (ensured.requestRun.activeRunIds as string[]).push('run-mutated');

  assert.deepEqual(registry.getRequestRunState('tool-1'), { activeRunIds: ['run-1'] });
});

test('session runtime registry get returns records that cannot mutate internal request run state', () => {
  const registry = new InMemorySessionRuntimeRegistry();

  registry.registerRequestRun('tool-1', 'run-1');
  const existing = registry.get('tool-1');
  assert.notEqual(existing, undefined);
  (existing.requestRun.activeRunIds as string[]).push('run-mutated');

  assert.deepEqual(registry.getRequestRunState('tool-1'), { activeRunIds: ['run-1'] });
});

test('session runtime registry release on missing session returns empty snapshot without creating record', () => {
  const registry = new InMemorySessionRuntimeRegistry();

  assert.deepEqual(registry.releaseRequestRun('missing-tool', 'run-x'), { activeRunIds: [] });
  assert.equal(registry.get('missing-tool'), undefined);
});

test('session runtime registry preserves seeded welinkSessionId across later ensures without the field', () => {
  const registry = new InMemorySessionRuntimeRegistry();

  registry.ensure({ toolSessionId: 'tool-1', welinkSessionId: 'we-1' });
  const preserved = registry.ensure({ toolSessionId: 'tool-1' });

  assert.equal(preserved.welinkSessionId, 'we-1');
});
