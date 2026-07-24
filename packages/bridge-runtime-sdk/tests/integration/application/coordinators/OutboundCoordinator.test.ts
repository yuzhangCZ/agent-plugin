import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderFactEnricher } from '@/application/ProviderFactEnricher.ts';
import { InteractionCoordinator, OutboundCoordinator } from '@/application/coordinators/index.ts';
import { FactSequenceValidator } from '@/application/fact-sequence-validator.ts';
import {
  DefaultFactToSkillEventProjector,
  DefaultRunTerminalSignalProjector,
  DefaultSkillEventToGatewayMessageProjector,
} from '@/application/projectors/index.ts';
import {
  DefaultRuntimeObservation,
  type RuntimeObservationEvent,
  type RuntimeObservationPort,
} from '@/application/runtime-observation/index.ts';
import { InMemoryPendingInteractionRegistry } from '@/infrastructure/registries/InMemoryPendingInteractionRegistry.ts';
import { InMemoryPermissionPresentationRegistry } from '@/infrastructure/registries/InMemoryPermissionPresentationRegistry.ts';
import { InMemorySessionRuntimeRegistry } from '@/infrastructure/registries/InMemorySessionRuntimeRegistry.ts';

class RecordingObservationPort implements RuntimeObservationPort {
  readonly events: RuntimeObservationEvent[] = [];

  record(event: RuntimeObservationEvent): void {
    this.events.push(event);
  }
}

function createOutboundCoordinator(input: {
  observation: DefaultRuntimeObservation;
  sinkMessages: Array<{ type: string; toolSessionId: string }>;
}) {
  const factEnricher = new ProviderFactEnricher(new InMemoryPermissionPresentationRegistry());
  return new OutboundCoordinator(
    new InMemorySessionRuntimeRegistry(),
    new InteractionCoordinator(new InMemoryPendingInteractionRegistry(), input.observation),
    new FactSequenceValidator(),
    {
      sink: {
        send(message) {
          input.sinkMessages.push({
            type: message.type,
            toolSessionId: 'toolSessionId' in message ? message.toolSessionId : '',
          });
        },
      },
      factProjector: new DefaultFactToSkillEventProjector(),
      eventProjector: new DefaultSkillEventToGatewayMessageProjector(),
      observation: input.observation,
    },
    factEnricher,
    new DefaultRunTerminalSignalProjector(),
  );
}

test('OutboundCoordinator keeps derived event and uplink projection observation split', async () => {
  const port = new RecordingObservationPort();
  const observation = new DefaultRuntimeObservation(port);
  const sinkMessages: Array<{ type: string; toolSessionId: string }> = [];
  const coordinator = createOutboundCoordinator({ observation, sinkMessages });

  await coordinator.emitOutbound({
    toolSessionId: 'tool-1',
    messageId: 'msg-1',
    facts: (async function* () {
      yield { type: 'message.start', messageId: 'msg-1' } as const;
      yield { type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: 'hi' } as const;
      yield { type: 'message.done', messageId: 'msg-1' } as const;
    })(),
  });

  const factEvents = port.events.filter(
    (event): event is Extract<RuntimeObservationEvent, { type: 'fact_processed' }> =>
      event.type === 'fact_processed',
  );
  const derivedEvents = factEvents.filter((event) => event.phase === 'derived_event_projected');
  const projectedEvents = factEvents.filter((event) => event.phase === 'projected');

  assert.deepEqual(
    derivedEvents.map((event) => ({ factType: event.factType, eventType: event.event.type })),
    [
      { factType: 'message.start', eventType: 'step.start' },
      { factType: 'message.done', eventType: 'step.done' },
    ],
  );
  assert.deepEqual(
    projectedEvents.map((event) => ({ factType: event.factType, uplinkType: event.uplinkType })),
    [{ factType: 'text.delta', uplinkType: 'tool_event' }],
  );
  assert.equal(sinkMessages.length, 3);
});

test('OutboundCoordinator records terminal observation when outbound run completes', async () => {
  const port = new RecordingObservationPort();
  const observation = new DefaultRuntimeObservation(port);
  const sinkMessages: Array<{ type: string; toolSessionId: string }> = [];
  const coordinator = createOutboundCoordinator({ observation, sinkMessages });

  await coordinator.emitOutboundRun({
    toolSessionId: 'tool-1',
    runId: 'outbound-run-1',
    facts: (async function* () {
      yield { type: 'message.start', messageId: 'msg-1' } as const;
      yield { type: 'message.done', messageId: 'msg-1' } as const;
    })(),
  });

  const terminalEvents = port.events.filter(
    (event): event is Extract<RuntimeObservationEvent, { type: 'terminal_progress' }> =>
      event.type === 'terminal_progress',
  );
  assert.deepEqual(
    terminalEvents.map((event) => ({
      phase: event.phase,
      toolSessionId: event.toolSessionId,
      runId: event.runId,
      outcome: event.result.outcome,
    })),
    [
      { phase: 'received', toolSessionId: 'tool-1', runId: 'outbound-run-1', outcome: 'completed' },
      { phase: 'projected', toolSessionId: 'tool-1', runId: 'outbound-run-1', outcome: 'completed' },
    ],
  );
  assert.deepEqual(sinkMessages.map((message) => message.type), ['tool_event', 'tool_event', 'tool_done']);
});
