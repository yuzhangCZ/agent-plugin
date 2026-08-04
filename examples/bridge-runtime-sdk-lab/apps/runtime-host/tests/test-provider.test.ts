import assert from 'node:assert/strict';
import test from 'node:test';

import { EventStore } from '../src/event-store.ts';
import { TestProvider } from '../src/test-provider.ts';

test('provider call events keep raw SDK to agent input text for lab inspection', async () => {
  const events = new EventStore();
  const provider = new TestProvider(events);

  await provider.runMessage({
    traceId: 'trace-1',
    runId: 'run-1',
    toolSessionId: 'tool-1',
    text: 'visible sdk to agent text',
  });

  const call = events.list().find((event) => event.type === 'provider.call');

  assert.equal(String(call?.meta?.rawInputText).includes('visible sdk to agent text'), true);
  assert.equal(JSON.stringify(call?.meta?.input).includes('visible sdk to agent text'), false);
});

test('provider emits manual outbound run to selected tool session', async () => {
  const events = new EventStore();
  const provider = new TestProvider(events);
  const emitted: unknown[] = [];
  await provider.initialize({
    outbound: {
      emitOutboundMessage: async () => ({ applied: true }),
      emitOutboundRun: async (input) => {
        emitted.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts: await collect(input.facts),
        });
        return { applied: true };
      },
    },
  });

  await provider.emitManualOutboundRun({
    toolSessionId: 'tool-real-session',
    runId: 'run-manual',
    trigger: 'sdk-lab',
    facts: [
      { type: 'message.start', messageId: 'msg-1' },
      { type: 'message.done', messageId: 'msg-1', reason: 'completed' },
    ],
  });

  assert.deepEqual(emitted, [{
    toolSessionId: 'tool-real-session',
    runId: 'run-manual',
    facts: [
      { type: 'message.start', messageId: 'msg-1' },
      { type: 'message.done', messageId: 'msg-1', reason: 'completed' },
    ],
  }]);
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of items) {
    collected.push(item);
  }
  return collected;
}
