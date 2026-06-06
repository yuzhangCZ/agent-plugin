import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryPendingInteractionRegistry } from '../src/infrastructure/registries/InMemoryPendingInteractionRegistry.ts';
import { InMemoryPermissionPresentationRegistry } from '../src/infrastructure/registries/InMemoryPermissionPresentationRegistry.ts';
import { InMemorySessionRuntimeRegistry } from '../src/infrastructure/registries/InMemorySessionRuntimeRegistry.ts';
import { ProviderFactEnricher } from '../src/application/ProviderFactEnricher.ts';
import { OutboundCoordinator, InteractionCoordinator } from '../src/application/coordinators/index.ts';
import { classifyFact } from '../src/application/fact-semantics.ts';
import { FactSequenceValidator } from '../src/application/fact-sequence-validator.ts';
import {
  DefaultFactToSkillEventProjector,
  DefaultRunTerminalSignalProjector,
  DefaultSkillEventToGatewayMessageProjector,
} from '../src/application/projectors/index.ts';
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
    marksOutboundTerminal: false,
    emitsDerivedEvent: true,
    projectsFactEvent: false,
  });

  assert.deepEqual(classifyFact('message.done'), {
    requiresOpenMessage: false,
    marksOutboundTerminal: true,
    emitsDerivedEvent: true,
    projectsFactEvent: false,
  });

  assert.deepEqual(classifyFact('tool.update'), {
    requiresOpenMessage: true,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  });

  assert.deepEqual(classifyFact('question.ask'), {
    requiresOpenMessage: true,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  });

  assert.deepEqual(classifyFact('permission.ask'), {
    requiresOpenMessage: false,
    marksOutboundTerminal: false,
    emitsDerivedEvent: false,
    projectsFactEvent: true,
  });
});

test('FactSequenceValidator enforces order and tool.update fail-closed rules without session lifecycle', () => {
  const validator = new FactSequenceValidator();

  const invalidToolUpdateState = validator.createState();
  validator.consume(
    'tool-1',
    { type: 'message.start', messageId: 'msg-1' },
    invalidToolUpdateState,
    { kind: 'request_run' },
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
    ),
    /tool\.update input\/output must not be blank strings/,
  );

  const outboundState = validator.createState();
  validator.consume(
    'tool-1',
    { type: 'message.start', messageId: 'msg-1' },
    outboundState,
    { kind: 'outbound' },
  );
  validator.consume(
    'tool-1',
    { type: 'message.done', messageId: 'msg-1' },
    outboundState,
    { kind: 'outbound' },
  );

  assert.throws(
    () => validator.consume(
      'tool-1',
      { type: 'session.error', error: { message: 'late' } },
      outboundState,
      { kind: 'outbound' },
    ),
    /facts after terminal are not allowed/,
  );
});

test('FactSequenceValidator accepts new activity after abort because lifecycle is provider-owned', () => {
  const validator = new FactSequenceValidator();
  const state = validator.createState();

  assert.doesNotThrow(() => validator.consume(
    'tool-1',
    { type: 'message.start', messageId: 'msg-after-abort' },
    state,
    { kind: 'request_run' },
  ));
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
      toolDoneCompatDelay: {
        sleep: async () => {},
        delayMs: 100,
      },
    },
    factEnricher,
    new DefaultRunTerminalSignalProjector(),
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

test('OutboundCoordinator records terminal observation when outbound run completes', async () => {
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
      toolDoneCompatDelay: {
        sleep: async () => {},
        delayMs: 100,
      },
    },
    factEnricher,
    new DefaultRunTerminalSignalProjector(),
  );

  await coordinator.emitOutboundRun({
    toolSessionId: 'tool-1',
    runId: 'outbound-run-1',
    facts: (async function* () {
      yield { type: 'message.start', messageId: 'msg-1' } as const;
      yield { type: 'message.done', messageId: 'msg-1' } as const;
    })(),
  });

  const terminalEvents = port.events.filter(
    (event): event is Extract<RuntimeObservationEvent, { type: 'terminal_progress' }> => event.type === 'terminal_progress',
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
