import assert from 'node:assert/strict';
import test from 'node:test';

import { CreateSessionUseCase } from '@/application/usecases/index.ts';

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

function createCommand() {
  return {
    kind: 'create_session',
    traceId: 'trace-create',
    source: {
      type: 'invoke',
      action: 'create_session',
      welinkSessionId: 'we-1',
      payload: {
        title: 'New chat',
        assistantId: 'assistant-1',
        extParameters: { channel: 'test' },
      },
    },
  } as never;
}

test('CreateSessionUseCase sends projected session_created response and preserves welinkSessionId', async () => {
  const sent: unknown[] = [];
  const ensured: unknown[] = [];
  const observation = new RecordingObservation();
  const useCase = new CreateSessionUseCase(
    {
      async createSession(input: unknown) {
        assert.deepEqual(input, {
          traceId: 'trace-create',
          title: 'New chat',
          assistantId: 'assistant-1',
          extParameters: { channel: 'test' },
        });
        return { toolSessionId: 'tool-1' };
      },
    } as never,
    {
      ensure(input: unknown) {
        ensured.push(input);
        return {
          toolSessionId: 'tool-1',
          welinkSessionId: 'we-1',
          requestRun: { activeRunIds: [] },
          outbound: { status: 'idle' as const },
        };
      },
    } as never,
    {
      send(message: unknown) {
        sent.push(message);
      },
    } as never,
    {
      projectSessionCreated(input: unknown) {
        return { type: 'session_created', input };
      },
    } as never,
    observation as never,
  );

  await useCase.execute(createCommand());

  assert.deepEqual(ensured, [{ toolSessionId: 'tool-1', welinkSessionId: 'we-1' }]);
  assert.deepEqual(sent, [{ type: 'session_created', input: { welinkSessionId: 'we-1', toolSessionId: 'tool-1' } }]);
  assert.deepEqual(observation.events.map((event) => event.method), [
    'usecaseStarted',
    'uplinkEmitted',
    'usecaseSucceeded',
  ]);
});

test('CreateSessionUseCase records failed observation when provider throws', async () => {
  const observation = new RecordingObservation();
  const useCase = new CreateSessionUseCase(
    {
      async createSession() {
        throw new Error('create_failed');
      },
    } as never,
    {
      ensure() {
        throw new Error('unexpected');
      },
    } as never,
    {
      send() {
        throw new Error('unexpected');
      },
    } as never,
    {
      projectSessionCreated() {
        throw new Error('unexpected');
      },
    } as never,
    observation as never,
  );

  await assert.rejects(() => useCase.execute(createCommand()), /create_failed/);

  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseFailed']);
});
