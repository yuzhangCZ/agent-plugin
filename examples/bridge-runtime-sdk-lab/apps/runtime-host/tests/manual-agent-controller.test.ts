import assert from 'node:assert/strict';
import test from 'node:test';

import { EventStore } from '../src/event-store.ts';
import { ManualAgentController } from '../src/manual-agent-controller.ts';

const runInput = {
  traceId: 'trace-1',
  runId: 'run-1',
  toolSessionId: 'tool-1',
  text: 'hello',
};

test('manual agent queues submitted ProviderFacts for an active run', async () => {
  const controller = new ManualAgentController(new EventStore());
  controller.setEnabled(true);
  const run = controller.startRun(runInput);
  const iterator = run.facts[Symbol.asyncIterator]();

  controller.submitFact({ type: 'message.start', messageId: 'msg-1' });
  controller.submitFact({ type: 'message.done', messageId: 'msg-1', reason: 'completed' });

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'message.start', messageId: 'msg-1' },
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'message.done', messageId: 'msg-1', reason: 'completed' },
  });

  controller.finishActiveRun({ outcome: 'completed' });

  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.deepEqual(await run.result(), { outcome: 'completed' });
});

test('manual agent templates use active run identifiers', () => {
  const controller = new ManualAgentController(new EventStore());
  controller.setEnabled(true);
  controller.startRun(runInput);

  const textDone = controller.templates().find((template) => template.id === 'text.done');

  assert.equal((textDone?.fact as { messageId?: string }).messageId?.startsWith('msg_'), true);
  assert.equal((textDone?.fact as { partId?: string }).partId?.startsWith('prt_'), true);
  assert.equal(controller.snapshot().activeRun?.toolSessionId, 'tool-1');
});

test('manual agent failed terminal resolves ProviderRun.result with ProviderError', async () => {
  const controller = new ManualAgentController(new EventStore());
  controller.setEnabled(true);
  const run = controller.startRun(runInput);

  controller.finishActiveRun({ outcome: 'failed', code: 'manual_code', message: 'manual failed' });

  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'internal_error',
      message: 'manual failed',
    },
  });
  assert.equal(controller.snapshot().activeRun, undefined);
});
