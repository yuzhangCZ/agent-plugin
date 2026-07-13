import assert from 'node:assert/strict';
import test from 'node:test';

import { AbortExecutionUseCase } from '@/application/usecases/index.ts';

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
    kind: 'abort_execution',
    traceId: 'trace-abort',
    source: {
      type: 'invoke',
      action: 'abort_session',
      payload: { toolSessionId: 'tool-1' },
    },
  } as never;
}

test('AbortExecutionUseCase forwards active run id and clears permission presentation state', async () => {
  const observation = new RecordingObservation();
  const abortCalls: unknown[] = [];
  const cleared: string[] = [];
  const useCase = new AbortExecutionUseCase(
    {
      async abortExecution(input: unknown) {
        abortCalls.push(input);
        return { applied: true as const };
      },
    } as never,
    {
      getRequestRunState() {
        return { activeRunIds: ['run-active'] };
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

  assert.deepEqual(abortCalls, [{ traceId: 'trace-abort', toolSessionId: 'tool-1', runIds: ['run-active'] }]);
  assert.deepEqual(cleared, ['tool-1']);
  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseSucceeded']);
});

test('AbortExecutionUseCase forwards empty run id set when no active run exists', async () => {
  const abortCalls: unknown[] = [];
  const useCase = new AbortExecutionUseCase(
    {
      async abortExecution(input: unknown) {
        abortCalls.push(input);
        return { applied: true as const };
      },
    } as never,
    {
      getRequestRunState() {
        return { activeRunIds: [] };
      },
    } as never,
    {
      clearSession() {},
    } as never,
    new RecordingObservation() as never,
  );

  await useCase.execute(createCommand());

  assert.deepEqual(abortCalls, [{ traceId: 'trace-abort', toolSessionId: 'tool-1', runIds: [] }]);
});

test('AbortExecutionUseCase records failed observation and does not swallow provider failure', async () => {
  const observation = new RecordingObservation();
  const useCase = new AbortExecutionUseCase(
    {
      async abortExecution() {
        throw new Error('provider_down');
      },
    } as never,
    {
      getRequestRunState() {
        return { activeRunIds: ['run-active'] };
      },
    } as never,
    {
      clearSession() {},
    } as never,
    observation as never,
  );

  await assert.rejects(() => useCase.execute(createCommand()), /provider_down/);

  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseFailed']);
});
