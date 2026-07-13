import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeLifecycleState } from '@/application/lifecycle/RuntimeLifecycleState.ts';
import { BridgeRuntimeError } from '@/application/runtime-error.ts';

test('RuntimeLifecycleState transitions idle to starting to ready and ignores stale start attempt', () => {
  const state = new RuntimeLifecycleState();

  const staleStart = state.beginStart();
  const currentStart = state.beginStart();

  assert.equal(state.finishStartIfCurrent(staleStart), false);
  assert.deepEqual(state.snapshot(), { state: 'starting', failureReason: null });
  assert.equal(state.finishStartIfCurrent(currentStart), true);
  assert.deepEqual(state.snapshot(), { state: 'ready', failureReason: null });
});

test('RuntimeLifecycleState transitions ready to stopping to idle and ignores stale stop attempt', () => {
  const state = new RuntimeLifecycleState();
  const start = state.beginStart();
  assert.equal(state.finishStartIfCurrent(start), true);

  const staleStop = state.beginStop();
  const currentStop = state.beginStop();

  assert.equal(state.finishStopIfCurrent(staleStop), false);
  assert.deepEqual(state.snapshot(), { state: 'stopping', failureReason: null });
  assert.equal(state.finishStopIfCurrent(currentStop), true);
  assert.deepEqual(state.snapshot(), { state: 'idle', failureReason: null });
});

test('RuntimeLifecycleState records immutable failed snapshots', () => {
  const state = new RuntimeLifecycleState();
  state.markFailed(new BridgeRuntimeError('provider_unavailable', 'provider failed'));

  const snapshot = state.snapshot();
  const secondSnapshot = state.snapshot();

  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.failureReason, 'provider failed');
  assert.equal(snapshot.error?.code, 'provider_unavailable');
  assert.equal(snapshot.error?.message, 'provider failed');
  assert.notEqual(snapshot.error, secondSnapshot.error);
});
