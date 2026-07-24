import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeCommandDispatcher } from '@/application/RuntimeCommandDispatcher.ts';

class RecordingObservation {
  readonly events: Array<{ method: string; args: unknown[] }> = [];

  commandDispatched(...args: unknown[]): void {
    this.events.push({ method: 'commandDispatched', args });
  }

  commandCompleted(...args: unknown[]): void {
    this.events.push({ method: 'commandCompleted', args });
  }

  commandFailed(...args: unknown[]): void {
    this.events.push({ method: 'commandFailed', args });
  }
}

function createUseCases(execute: (command: unknown) => Promise<void>) {
  const useCase = { execute };
  return {
    query_status: useCase,
    create_session: useCase,
    list_slash_commands: useCase,
    start_request_run: useCase,
    reply_question: useCase,
    reply_permission: useCase,
    close_session: useCase,
    abort_execution: useCase,
  };
}

test('RuntimeCommandDispatcher routes command by kind and records completed observation', async () => {
  const observation = new RecordingObservation();
  const handled: unknown[] = [];
  const dispatcher = new RuntimeCommandDispatcher(
    {
      ...createUseCases(async () => {}),
      query_status: {
        async execute(command: unknown) {
          handled.push(command);
        },
      },
    } as never,
    observation as never,
  );
  const command = { kind: 'query_status', traceId: 'trace-1', source: { type: 'status_query' } } as never;

  await dispatcher.dispatch(command);

  assert.deepEqual(handled, [command]);
  assert.deepEqual(observation.events.map((event) => event.method), ['commandDispatched', 'commandCompleted']);
});

test('RuntimeCommandDispatcher records failed observation and rethrows usecase errors', async () => {
  const observation = new RecordingObservation();
  const dispatcher = new RuntimeCommandDispatcher(
    createUseCases(async () => {
      throw new Error('usecase_failed');
    }) as never,
    observation as never,
  );

  await assert.rejects(
    () => dispatcher.dispatch({ kind: 'query_status', traceId: 'trace-1', source: { type: 'status_query' } } as never),
    /usecase_failed/,
  );

  assert.deepEqual(observation.events.map((event) => event.method), ['commandDispatched', 'commandFailed']);
});

test('RuntimeCommandDispatcher extracts toolSessionId and welinkSessionId from source payload context', async () => {
  const observation = new RecordingObservation();
  const dispatcher = new RuntimeCommandDispatcher(createUseCases(async () => {}) as never, observation as never);

  await dispatcher.dispatch({
    kind: 'start_request_run',
    traceId: 'trace-chat',
    source: {
      type: 'invoke',
      action: 'chat',
      welinkSessionId: 'we-1',
      payload: { toolSessionId: 'tool-1', text: 'hello' },
    },
  } as never);

  assert.deepEqual(observation.events[0], {
    method: 'commandDispatched',
    args: ['start_request_run', 'trace-chat', { welinkSessionId: 'we-1', toolSessionId: 'tool-1' }],
  });
});
