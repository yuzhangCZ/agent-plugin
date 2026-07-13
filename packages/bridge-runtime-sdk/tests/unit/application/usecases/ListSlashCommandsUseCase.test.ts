import assert from 'node:assert/strict';
import test from 'node:test';

import { ListSlashCommandsUseCase } from '@/application/usecases/index.ts';

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
    kind: 'list_slash_commands',
    traceId: 'trace-list',
    source: {
      type: 'invoke',
      action: 'query_slash_commands',
      traceId: 'gateway-trace',
      toolSessionId: 'tool-1',
      payload: { extParameters: { channel: 'test' } },
    },
  } as never;
}

test('ListSlashCommandsUseCase sends projected slash command list on provider success', async () => {
  const sent: unknown[] = [];
  const observation = new RecordingObservation();
  const useCase = new ListSlashCommandsUseCase(
    {
      async listSlashCommands(input: unknown) {
        assert.deepEqual(input, { traceId: 'trace-list', extParameters: { channel: 'test' } });
        return { slashCommands: [{ command: '/new', description: 'New session' }] };
      },
    } as never,
    {
      send(message: unknown) {
        sent.push(message);
      },
    } as never,
    {
      projectSlashCommands(input: unknown) {
        return { type: 'slash_commands_result', input };
      },
    } as never,
    observation as never,
  );

  await useCase.execute(createCommand());

  assert.deepEqual(sent, [{
    type: 'slash_commands_result',
    input: {
      toolSessionId: 'tool-1',
      traceId: 'gateway-trace',
      slashCommands: [{ command: '/new', description: 'New session' }],
    },
  }]);
  assert.deepEqual(observation.events.map((event) => event.method), [
    'usecaseStarted',
    'uplinkEmitted',
    'usecaseSucceeded',
  ]);
});

test('ListSlashCommandsUseCase sends empty slash command list and records failure on provider failure', async () => {
  const sent: unknown[] = [];
  const observation = new RecordingObservation();
  const useCase = new ListSlashCommandsUseCase(
    {
      async listSlashCommands() {
        throw new Error('list_failed');
      },
    } as never,
    {
      send(message: unknown) {
        sent.push(message);
      },
    } as never,
    {
      projectSlashCommands(input: unknown) {
        return { type: 'slash_commands_result', input };
      },
    } as never,
    observation as never,
  );

  await useCase.execute(createCommand());

  assert.deepEqual(sent, [{
    type: 'slash_commands_result',
    input: { toolSessionId: 'tool-1', traceId: 'gateway-trace', slashCommands: [] },
  }]);
  assert.deepEqual(observation.events.map((event) => event.method), [
    'usecaseStarted',
    'usecaseFailed',
    'uplinkEmitted',
    'usecaseSucceeded',
  ]);
});
