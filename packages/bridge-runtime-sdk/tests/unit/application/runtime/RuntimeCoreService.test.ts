import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeCoreService } from '@/application/runtime/RuntimeCoreService.ts';

class RecordingObservation {
  readonly events: string[] = [];

  runtimeCoreStarted(): void {
    this.events.push('runtimeCoreStarted');
  }

  runtimeCoreStopped(): void {
    this.events.push('runtimeCoreStopped');
  }
}

test('RuntimeCoreService starts provider once and exposes outbound emitters', async () => {
  const observation = new RecordingObservation();
  const outboundCalls: unknown[] = [];
  const initializeContexts: unknown[] = [];
  const service = new RuntimeCoreService({
    provider: {
      async initialize(context: unknown) {
        initializeContexts.push(context);
      },
    },
    dispatcher: { async dispatch() {} },
    outboundEmitter: {
      async emitOutbound(input: unknown) {
        outboundCalls.push({ kind: 'message', input });
        return { applied: true as const };
      },
      async emitOutboundRun(input: unknown) {
        outboundCalls.push({ kind: 'run', input });
        return { applied: true as const };
      },
    },
    observation,
  } as never);

  await service.start();
  await service.start();

  assert.equal(initializeContexts.length, 1);
  const context = initializeContexts[0] as {
    outbound: {
      emitOutboundMessage(input: unknown): Promise<unknown>;
      emitOutboundRun(input: unknown): Promise<unknown>;
    };
  };
  await context.outbound.emitOutboundMessage({ toolSessionId: 'tool-1', messageId: 'msg-1', facts: [] });
  await context.outbound.emitOutboundRun({ toolSessionId: 'tool-1', runId: 'run-1', facts: [] });
  assert.deepEqual(outboundCalls, [
    { kind: 'message', input: { toolSessionId: 'tool-1', messageId: 'msg-1', facts: [] } },
    { kind: 'run', input: { toolSessionId: 'tool-1', runId: 'run-1', facts: [] } },
  ]);
  assert.deepEqual(observation.events, ['runtimeCoreStarted']);
});

test('RuntimeCoreService stops provider once after start', async () => {
  const observation = new RecordingObservation();
  let disposeCount = 0;
  const service = new RuntimeCoreService({
    provider: {
      async initialize() {},
      async dispose() {
        disposeCount += 1;
      },
    },
    dispatcher: { async dispatch() {} },
    outboundEmitter: {
      async emitOutbound() {
        return { applied: true };
      },
      async emitOutboundRun() {
        return { applied: true };
      },
    },
    observation,
  } as never);

  await service.start();
  await service.stop();
  await service.stop();

  assert.equal(disposeCount, 1);
  assert.deepEqual(observation.events, ['runtimeCoreStarted', 'runtimeCoreStopped']);
});

test('RuntimeCoreService leaves stopped status when provider start fails', async () => {
  const observation = new RecordingObservation();
  let disposeCount = 0;
  const service = new RuntimeCoreService({
    provider: {
      async initialize() {
        throw new Error('initialize_failed');
      },
      async dispose() {
        disposeCount += 1;
      },
    },
    dispatcher: { async dispatch() {} },
    outboundEmitter: {
      async emitOutbound() {
        return { applied: true };
      },
      async emitOutboundRun() {
        return { applied: true };
      },
    },
    observation,
  } as never);

  await assert.rejects(() => service.start(), /initialize_failed/);
  await service.stop();

  assert.equal(disposeCount, 0);
  assert.deepEqual(observation.events, []);
});
