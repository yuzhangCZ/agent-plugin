import assert from 'node:assert/strict';
import test from 'node:test';

import { RequestRunCoordinator } from '@/application/coordinators/index.ts';
import { RuntimeContractError } from '@/domain/errors.ts';

function createCoordinator(input: {
  events: string[];
  validatorError?: RuntimeContractError;
}) {
  return new RequestRunCoordinator(
    {
      registerFromFact() {
        input.events.push('interaction.registerFromFact');
      },
    } as never,
    {
      createState() {
        return {};
      },
      consume() {
        input.events.push('validator.consume');
        if (input.validatorError) {
          throw input.validatorError;
        }
      },
    } as never,
    {
      sink: {
        send(message: unknown) {
          input.events.push(`sink.${(message as { type: string }).type}`);
        },
      },
      factProjector: {
        project(fact: unknown) {
          input.events.push(`factProjector.${(fact as { type: string }).type}`);
          return [{ protocol: 'cloud', type: 'text.delta', properties: {} }];
        },
      },
      eventProjector: {
        project() {
          input.events.push('eventProjector.project');
          return { type: 'tool_event', toolSessionId: 'tool-1' };
        },
      },
      observation: {
        factReceived() {
          input.events.push('observation.factReceived');
        },
        derivedEventProjected() {
          input.events.push('observation.derivedEventProjected');
        },
        uplinkProjected() {
          input.events.push('observation.uplinkProjected');
        },
        uplinkEmitted(message: unknown) {
          input.events.push(`observation.uplinkEmitted.${(message as { type: string }).type}`);
        },
        failureRecorded() {
          input.events.push('observation.failureRecorded');
        },
        terminalReceived() {
          input.events.push('observation.terminalReceived');
        },
        terminalProjected() {
          input.events.push('observation.terminalProjected');
        },
      },
    } as never,
    {
      enrich(_toolSessionId: string, fact: unknown) {
        return { ok: true as const, fact };
      },
    } as never,
    {
      project() {
        input.events.push('terminalProjector.project');
        return { type: 'tool_done', toolSessionId: 'tool-1' };
      },
    } as never,
    {
      project() {
        input.events.push('requestRunFailureProjector.project');
        return { type: 'tool_error', toolSessionId: 'tool-1', error: 'request failed' };
      },
    } as never,
  );
}

test('RequestRunCoordinator records terminal projected event before sending terminal uplink', async () => {
  const events: string[] = [];
  const coordinator = createCoordinator({ events });

  await coordinator.executeRun({
    toolSessionId: 'tool-1',
    welinkSessionId: 'we-1',
    runId: 'run-1',
    run: {
      runId: 'run-1',
      facts: (async function* () {})(),
      async result() {
        return { outcome: 'completed' as const };
      },
    },
  });

  assert.deepEqual(events, [
    'observation.terminalReceived',
    'terminalProjector.project',
    'observation.terminalProjected',
    'observation.uplinkEmitted.tool_done',
    'sink.tool_done',
  ]);
});

test('RequestRunCoordinator emits request-run failure tool_error for lifecycle fact failures', async () => {
  const events: string[] = [];
  const lifecycleError = new RuntimeContractError(
    'fact_sequence_invalid',
    'invalid fact sequence',
    { toolSessionId: 'tool-1' },
  );
  const coordinator = createCoordinator({ events, validatorError: lifecycleError });

  await assert.rejects(
    () => coordinator.executeRun({
      toolSessionId: 'tool-1',
      welinkSessionId: 'we-1',
      runId: 'run-1',
      run: {
        runId: 'run-1',
        facts: (async function* () {
          yield {
            type: 'text.delta',
            messageId: 'msg-1',
            partId: 'part-1',
            content: 'hello',
          } as const;
        })(),
        async result() {
          return { outcome: 'completed' as const };
        },
      },
    }),
    lifecycleError,
  );

  assert.equal(events.includes('requestRunFailureProjector.project'), true);
  assert.equal(events.includes('observation.uplinkEmitted.tool_error'), true);
  assert.equal(events.includes('sink.tool_error'), true);
});
