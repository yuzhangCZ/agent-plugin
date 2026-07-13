import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFact } from '@/application/fact-semantics.ts';

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
