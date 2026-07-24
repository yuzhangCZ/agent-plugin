import assert from 'node:assert/strict';
import test from 'node:test';

import { OutboundCoordinator } from '@/application/coordinators/index.ts';

function createCoordinator(input: {
  releaseCalls: Array<{ toolSessionId: string; messageId: string }>;
  events: string[];
  sink?: { send(message: unknown): void | Promise<void> };
}) {
  return new OutboundCoordinator(
    {
      acquireOutboundEmission(toolSessionId: string, messageId: string) {
        return {
          ok: true as const,
          record: {
            toolSessionId,
            requestRun: { activeRunIds: [] },
            outbound: { status: 'emitting' as const, messageId },
          },
        };
      },
      releaseOutboundEmission(toolSessionId: string, messageId: string) {
        input.releaseCalls.push({ toolSessionId, messageId });
      },
    } as never,
    {
      registerFromFact() {
        input.events.push('interaction.registerFromFact');
      },
    } as never,
    {
      createState() {
        return {};
      },
      consume() {},
    } as never,
    {
      sink: input.sink ?? {
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
  );
}

test('OutboundCoordinator releases outbound emission lock when sink send throws', async () => {
  const releaseCalls: Array<{ toolSessionId: string; messageId: string }> = [];
  const events: string[] = [];
  const coordinator = createCoordinator({
    releaseCalls,
    events,
    sink: {
      send() {
        throw new Error('sink_failed');
      },
    },
  });

  await assert.rejects(
    () => coordinator.emitOutbound({
      toolSessionId: 'tool-1',
      messageId: 'msg-1',
      facts: (async function* () {
        yield {
          type: 'text.delta',
          messageId: 'msg-1',
          partId: 'part-1',
          content: 'hello',
        } as const;
      })(),
    }),
    /sink_failed/,
  );

  assert.deepEqual(releaseCalls, [{ toolSessionId: 'tool-1', messageId: 'msg-1' }]);
});

test('OutboundCoordinator records terminal received and projected events before sending terminal uplink', async () => {
  const releaseCalls: Array<{ toolSessionId: string; messageId: string }> = [];
  const events: string[] = [];
  const coordinator = createCoordinator({ releaseCalls, events });

  await coordinator.emitOutboundRun({
    toolSessionId: 'tool-1',
    runId: 'run-1',
    facts: (async function* () {})(),
  });

  assert.deepEqual(events, [
    'observation.terminalReceived',
    'terminalProjector.project',
    'observation.terminalProjected',
    'observation.uplinkEmitted.tool_done',
    'sink.tool_done',
  ]);
  assert.deepEqual(releaseCalls, [{ toolSessionId: 'tool-1', messageId: 'run-1' }]);
});
