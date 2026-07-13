import assert from 'node:assert/strict';
import test from 'node:test';

import { CloseSessionUseCase } from '@/application/usecases/index.ts';

class RecordingObservation {
  readonly events: Array<{ method: string; args: unknown[] }> = [];

  usecaseStarted(...args: unknown[]): void {
    this.events.push({ method: 'usecaseStarted', args });
  }

  usecaseSucceeded(...args: unknown[]): void {
    this.events.push({ method: 'usecaseSucceeded', args });
  }

  usecaseFailed(...args: unknown[]): void {
    this.events.push({ method: 'usecaseFailed', args });
  }
}

function createCommand() {
  return {
    kind: 'close_session',
    traceId: 'trace-close',
    source: {
      type: 'invoke',
      action: 'close_session',
      payload: { toolSessionId: 'tool-1' },
    },
  } as never;
}

test('CloseSessionUseCase forwards closeSession and clears local session state', async () => {
  const closeCalls: unknown[] = [];
  const deleted: string[] = [];
  const cleared: string[] = [];
  const observation = new RecordingObservation();
  const useCase = new CloseSessionUseCase(
    {
      async closeSession(input: unknown) {
        closeCalls.push(input);
        return { applied: true as const };
      },
    } as never,
    {
      delete(toolSessionId: string) {
        deleted.push(toolSessionId);
      },
    } as never,
    {
      clearSession(toolSessionId: string) {
        cleared.push(toolSessionId);
      },
    } as never,
    observation as never,
  );

  await useCase.execute(createCommand());

  assert.deepEqual(closeCalls, [{ traceId: 'trace-close', toolSessionId: 'tool-1' }]);
  assert.deepEqual(cleared, ['tool-1']);
  assert.deepEqual(deleted, ['tool-1']);
  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseSucceeded']);
});

test('CloseSessionUseCase records failed observation when provider throws', async () => {
  const observation = new RecordingObservation();
  const useCase = new CloseSessionUseCase(
    {
      async closeSession() {
        throw new Error('close_failed');
      },
    } as never,
    {
      delete() {
        throw new Error('unexpected');
      },
    } as never,
    {
      clearSession() {
        throw new Error('unexpected');
      },
    } as never,
    observation as never,
  );

  await assert.rejects(() => useCase.execute(createCommand()), /close_failed/);

  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseFailed']);
});
