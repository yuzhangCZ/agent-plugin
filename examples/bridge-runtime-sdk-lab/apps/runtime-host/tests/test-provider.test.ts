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
