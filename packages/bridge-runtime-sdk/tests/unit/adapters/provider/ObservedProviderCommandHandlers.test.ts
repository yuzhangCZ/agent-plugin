import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ObservedProviderCommandHandlers,
  type ProviderCommandHandlers,
} from '@/adapters/provider/provider-api-adapter.ts';
import {
  DefaultRuntimeObservation,
  type RuntimeObservationEvent,
  type RuntimeObservationPort,
} from '@/application/runtime-observation/index.ts';

class RecordingObservationPort implements RuntimeObservationPort {
  readonly events: RuntimeObservationEvent[] = [];

  record(event: RuntimeObservationEvent): void {
    this.events.push(event);
  }
}

test('observed provider handlers emit started and failed observation events', async () => {
  const port = new RecordingObservationPort();
  const observation = new DefaultRuntimeObservation(port);
  const handlers: ProviderCommandHandlers = new ObservedProviderCommandHandlers(
    {
      async queryStatus() {
        throw new Error('provider_down');
      },
      async createSession() {
        return { toolSessionId: 'tool-1' };
      },
      async listSlashCommands() {
        return {
          slashCommands: [
            { command: '/new', description: '新建会话' },
          ],
        };
      },
      async startRequestRun() {
        return {
          runId: 'run-1',
          facts: (async function* () {})(),
          async result() {
            return { outcome: 'completed' as const };
          },
        };
      },
      async replyQuestion() {
        return { applied: true };
      },
      async replyPermission() {
        return { applied: true };
      },
      async closeSession() {
        return { applied: true };
      },
      async abortExecution() {
        return { applied: true };
      },
    },
    observation,
  );

  await assert.rejects(() => handlers.queryStatus({ traceId: 'trace-1' }), /provider_down/);
  await handlers.listSlashCommands({ traceId: 'trace-list' });
  assert.deepEqual(port.events, [
    {
      type: 'provider_call',
      phase: 'started',
      command: 'queryStatus',
      traceId: 'trace-1',
    },
    {
      type: 'provider_call',
      phase: 'failed',
      command: 'queryStatus',
      traceId: 'trace-1',
      error: 'provider_down',
      code: undefined,
    },
    {
      type: 'provider_call',
      phase: 'started',
      command: 'listSlashCommands',
      traceId: 'trace-list',
    },
    {
      type: 'provider_call',
      phase: 'succeeded',
      command: 'listSlashCommands',
      traceId: 'trace-list',
      slashCommandCount: 1,
      slashCommands: [
        { command: '/new', description: '新建会话' },
      ],
    },
  ]);
});
