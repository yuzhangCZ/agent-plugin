import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeProbeService } from '@/application/lifecycle/RuntimeProbeService.ts';
import { BridgeRuntimeError } from '@/application/runtime-error.ts';

test('RuntimeProbeService short-circuits ready runtime without temporary probe', async () => {
  let probeCalled = false;
  const service = new RuntimeProbeService({
    async probe() {
      probeCalled = true;
      return { state: 'ready', latencyMs: 1 };
    },
  });

  const result = await service.probe({ state: 'ready', failureReason: null });

  assert.deepEqual(result, { state: 'ready', latencyMs: 0, reason: 'runtime_ready' });
  assert.equal(probeCalled, false);
});

test('RuntimeProbeService skips temporary probe while lifecycle is busy', async () => {
  let probeCalled = false;
  const service = new RuntimeProbeService({
    async probe() {
      probeCalled = true;
      return { state: 'ready', latencyMs: 1 };
    },
  });

  const result = await service.probe({ state: 'starting', failureReason: null });

  assert.equal(result.state, 'connecting');
  assert.equal(result.reason, 'runtime_lifecycle_busy_probe_skipped');
  assert.equal(probeCalled, false);
});

test('RuntimeProbeService deduplicates concurrent probes by timeout', async () => {
  let calls = 0;
  const service = new RuntimeProbeService({
    async probe() {
      calls += 1;
      return { state: 'ready', latencyMs: 3 };
    },
  });

  const [first, second] = await Promise.all([
    service.probe({ state: 'idle', failureReason: null }, { timeoutMs: 100 }),
    service.probe({ state: 'idle', failureReason: null }, { timeoutMs: 100 }),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(first, { state: 'ready', latencyMs: 3 });
  assert.deepEqual(second, { state: 'ready', latencyMs: 3 });
});

test('RuntimeProbeService cancels active probes and swallows cancellation rejection', async () => {
  let capturedSignal: AbortSignal | undefined;
  const service = new RuntimeProbeService({
    probe(input: { abortSignal?: AbortSignal }) {
      capturedSignal = input.abortSignal;
      return new Promise((_, reject) => {
        input.abortSignal?.addEventListener('abort', () => {
          reject(input.abortSignal?.reason);
        });
      });
    },
  });

  const pendingProbe = service.probe({ state: 'idle', failureReason: null }, { timeoutMs: 100 });
  await service.cancelActiveProbe();

  assert.equal(capturedSignal?.aborted, true);
  await assert.rejects(pendingProbe, /probe_cancelled_for_runtime_lifecycle/);
});

test('RuntimeProbeService maps synchronous probe throw through probe failure classifier', async () => {
  const service = new RuntimeProbeService({
    probe() {
      throw new Error('probe exploded');
    },
  });

  await assert.rejects(
    () => service.probe({ state: 'idle', failureReason: null }, { timeoutMs: 100 }),
    (error) => error instanceof BridgeRuntimeError && error.code === 'probe_unknown_error',
  );
});
