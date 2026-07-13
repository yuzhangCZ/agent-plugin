import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryStatusUseCase } from '@/application/usecases/index.ts';

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

  uplinkEmitted(...args: unknown[]): void {
    this.events.push({ method: 'uplinkEmitted', args });
  }
}

const command = {
  kind: 'query_status',
  traceId: 'trace-status',
  source: { type: 'status_query' },
} as never;

test('QueryStatusUseCase sends projected status response on provider success', async () => {
  const observation = new RecordingObservation();
  const sent: unknown[] = [];
  const useCase = new QueryStatusUseCase(
    {
      async queryStatus(input: unknown) {
        assert.deepEqual(input, { traceId: 'trace-status' });
        return { online: true };
      },
    } as never,
    {
      send(message: unknown) {
        sent.push(message);
      },
    } as never,
    {
      projectStatus(input: { online: boolean }) {
        return { type: 'status_response', opencodeOnline: input.online };
      },
    } as never,
    observation as never,
  );

  await useCase.execute(command);

  assert.deepEqual(sent, [{ type: 'status_response', opencodeOnline: true }]);
  assert.deepEqual(observation.events.map((event) => event.method), [
    'usecaseStarted',
    'uplinkEmitted',
    'usecaseSucceeded',
  ]);
});

test('QueryStatusUseCase records failure and rethrows provider failure', async () => {
  const observation = new RecordingObservation();
  const sent: unknown[] = [];
  const useCase = new QueryStatusUseCase(
    {
      async queryStatus() {
        throw new Error('query_failed');
      },
    } as never,
    {
      send(message: unknown) {
        sent.push(message);
      },
    } as never,
    {
      projectStatus() {
        throw new Error('unexpected');
      },
    } as never,
    observation as never,
  );

  await assert.rejects(() => useCase.execute(command), /query_failed/);

  assert.deepEqual(sent, []);
  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseFailed']);
});
