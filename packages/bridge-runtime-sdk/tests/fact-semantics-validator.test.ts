import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryPendingInteractionRegistry } from '../src/infrastructure/registries/InMemoryPendingInteractionRegistry.ts';
import { InMemoryPermissionPresentationRegistry } from '../src/infrastructure/registries/InMemoryPermissionPresentationRegistry.ts';
import { InMemorySessionRuntimeRegistry } from '../src/infrastructure/registries/InMemorySessionRuntimeRegistry.ts';
import { ProviderFactEnricher } from '../src/application/ProviderFactEnricher.ts';
import { OutboundCoordinator, InteractionCoordinator } from '../src/application/coordinators/index.ts';
import { classifyFact } from '../src/application/fact-semantics.ts';
import { FactSequenceValidator } from '../src/application/fact-sequence-validator.ts';
import { DefaultFactToSkillEventProjector, DefaultSkillEventToGatewayMessageProjector } from '../src/application/projectors/index.ts';
import { DefaultRuntimeObservation, type RuntimeObservationEvent, type RuntimeObservationPort } from '../src/application/runtime-observation/index.ts';

class RecordingObservationPort implements RuntimeObservationPort {
  readonly events: RuntimeObservationEvent[] = [];

  record(event: RuntimeObservationEvent): void {
    this.events.push(event);
  }
}

test('classifyFact returns stable application semantics for representative fact types', () => {
  assert.deepEqual(classifyFact('message.start'), {
    requiresOpenMessage: false,
    rejectInAbortingSession: true,
    marksOutboundTerminal: false,
    emitsDerivedEvent: true,
    projectsFactEvent: false,
  });

  assert.deepEqual(classifyFact('message.done'), {
    requiresOpenMessage: false,
    rejectInAbortingSession: false,
    marksOutboundTerminal: true,
    emitsDerivedEvent: true,
    projectsFactEvent: false,
  });

  assert.deepEqual(classifyFact('tool.update'), {
    requiresOpenMessage: true,
    rejectInAbortingSession: false,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  });

  assert.deepEqual(classifyFact('question.ask'), {
    requiresOpenMessage: true,
    rejectInAbortingSession: true,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  });

  assert.deepEqual(classifyFact('permission.ask'), {
    requiresOpenMessage: false,
    rejectInAbortingSession: true,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  });
});

test('FactSequenceValidator enforces lifecycle, order, and tool.update fail-closed rules', () => {
  const validator = new FactSequenceValidator();

  assert.throws(
    () => validator.consume(
      'tool-1',
      { type: 'message.start', messageId: 'msg-1' },
      validator.createState(),
      { kind: 'request_run' },
      'closed',
    ),
    /closed session must reject all facts/,
  );

  assert.throws(
    () => validator.consume(
      'tool-1',
      { type: 'message.start', messageId: 'msg-1' },
      validator.createState(),
      { kind: 'request_run' },
      'aborting',
    ),
    /aborting session rejects new activity facts/,
  );

  const invalidToolUpdateState = validator.createState();
  validator.consume(
    'tool-1',
    { type: 'message.start', messageId: 'msg-1' },
    invalidToolUpdateState,
    { kind: 'request_run' },
    'active',
  );

  assert.throws(
    () => validator.consume(
      'tool-1',
      {
        type: 'tool.update',
        messageId: 'msg-1',
        partId: 'part-1',
        toolCallId: 'call-1',
        toolName: 'shell',
        status: 'running',
        output: '   ',
      },
      invalidToolUpdateState,
      { kind: 'request_run' },
      'active',
    ),
    /tool\.update input\/output must not be blank strings/,
  );

  const outboundState = validator.createState();
  validator.consume(
    'tool-1',
    { type: 'message.start', messageId: 'msg-1' },
    outboundState,
    { kind: 'outbound' },
    'active',
  );
  validator.consume(
    'tool-1',
    { type: 'message.done', messageId: 'msg-1' },
    outboundState,
    { kind: 'outbound' },
    'active',
  );

  assert.throws(
    () => validator.consume(
      'tool-1',
      { type: 'session.error', error: { message: 'late' } },
      outboundState,
      { kind: 'outbound' },
      'active',
    ),
    /facts after terminal are not allowed/,
  );
});

test('OutboundCoordinator keeps derived event and uplink projection observation split', async () => {
  const port = new RecordingObservationPort();
  const observation = new DefaultRuntimeObservation(port);
  const sinkMessages: Array<{ type: string; toolSessionId: string }> = [];
  const factEnricher = new ProviderFactEnricher(new InMemoryPermissionPresentationRegistry());
  const coordinator = new OutboundCoordinator(
    new InMemorySessionRuntimeRegistry(),
    new InteractionCoordinator(new InMemoryPendingInteractionRegistry(), observation),
    new FactSequenceValidator(),
    {
      sink: {
        send(message) {
          sinkMessages.push({ type: message.type, toolSessionId: 'toolSessionId' in message ? message.toolSessionId : '' });
        },
      },
      factProjector: new DefaultFactToSkillEventProjector(),
      eventProjector: new DefaultSkillEventToGatewayMessageProjector(),
      observation,
    },
    factEnricher,
  );

  await coordinator.emitOutbound({
    toolSessionId: 'tool-1',
    messageId: 'msg-1',
    facts: (async function* () {
      yield { type: 'message.start', messageId: 'msg-1' } as const;
      yield { type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: 'hi' } as const;
      yield { type: 'message.done', messageId: 'msg-1' } as const;
    })(),
  });

  const factEvents = port.events.filter((event): event is Extract<RuntimeObservationEvent, { type: 'fact_processed' }> => event.type === 'fact_processed');
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
