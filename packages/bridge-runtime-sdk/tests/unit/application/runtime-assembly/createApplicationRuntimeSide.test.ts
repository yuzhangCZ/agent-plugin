import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { createApplicationRuntimeSide } from '@/application/runtime-assembly/createApplicationRuntimeSide.ts';
import { DefaultRuntimeObservation } from '@/application/runtime-observation/index.ts';

function createCommand(traceId: string) {
  return {
    kind: 'start_request_run',
    traceId,
    source: {
      type: 'invoke',
      action: 'chat',
      welinkSessionId: 'we-1',
      payload: {
        toolSessionId: 'tool-1',
        text: 'hello',
      },
    },
  } as never;
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

test('createApplicationRuntimeSide wires forwardToProvider request run policy into start usecase', async () => {
  const runFinished = createDeferred();
  const providerCalls: unknown[] = [];
  const observation = new DefaultRuntimeObservation({ record() {} });
  const applicationSide = createApplicationRuntimeSide(
    {
      provider: {
        async health() {
          return { status: 'ok' as const };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async listSlashCommands() {
          return { slashCommands: [] };
        },
        async runMessage(input: unknown) {
          providerCalls.push(input);
          return {
            runId: `provider-run-${providerCalls.length}`,
            facts: (async function* () {
              await runFinished.promise;
            })(),
            async result() {
              await runFinished.promise;
              return { outcome: 'completed' as const };
            },
          };
        },
        async replyQuestion() {
          return { applied: true as const };
        },
        async replyPermission() {
          return { applied: true as const };
        },
        async closeSession() {
          return { applied: true as const };
        },
        async abortSession() {
          return { applied: true as const };
        },
      },
      gatewayHost: { gatewayUrl: 'http://127.0.0.1:18080', register: { channel: 'test' } },
      requestRunPolicy: { activeRunChatPolicy: 'forwardToProvider' },
    },
    {
      provider: {} as never,
      gatewayHost: {} as never,
      toolDoneCompatDelay: { delayMs: 0, sleep: async () => {} },
    },
    observation,
    { send() {} } as never,
  );

  const firstRun = applicationSide.core.handleCommand(createCommand('trace-1'));
  await sleep(0);
  const secondRun = applicationSide.core.handleCommand(createCommand('trace-2'));
  await sleep(0);

  assert.equal(providerCalls.length, 2);

  runFinished.resolve();
  await Promise.all([firstRun, secondRun]);
});
