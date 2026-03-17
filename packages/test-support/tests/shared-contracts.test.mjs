import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChatInvokeMessage,
  createCompatInvalidInvokeStatusQueryMessage,
  createCreateSessionInvokeMessage,
  createStatusQueryMessage,
} from '../fixtures/index.mjs';
import {
  assertNoSuccessMessageOnInvalidInput,
  assertSessionCreatedShape,
  assertStatusResponseShape,
  assertToolDoneShape,
  assertToolErrorShape,
  assertToolEventShape,
} from '../assertions/index.mjs';
import { createMessageRecorder, createMockGateway } from '../transport/index.mjs';
import { waitFor } from '../timing/index.mjs';

test('shared fixtures and assertions expose the baseline protocol helpers', async () => {
  assert.deepStrictEqual(createStatusQueryMessage(), { type: 'status_query' });
  assert.strictEqual(createChatInvokeMessage().action, 'chat');
  assert.strictEqual(createCreateSessionInvokeMessage().action, 'create_session');
  assert.strictEqual(createCompatInvalidInvokeStatusQueryMessage().action, 'status_query');

  assert.doesNotThrow(() => assertToolDoneShape({ type: 'tool_done', welinkSessionId: 'wl', toolSessionId: 'tool' }, { welinkSessionId: 'wl', toolSessionId: 'tool' }));
  assert.doesNotThrow(() => assertSessionCreatedShape({ type: 'session_created', welinkSessionId: 'wl', toolSessionId: 'tool' }, { welinkSessionId: 'wl', toolSessionId: 'tool' }));
  assert.doesNotThrow(() => assertStatusResponseShape({ type: 'status_response', opencodeOnline: true }, { opencodeOnline: true, envelopeFree: true }));
  assert.doesNotThrow(() => assertToolErrorShape({ type: 'tool_error', error: 'bad', welinkSessionId: 'wl' }, { welinkSessionId: 'wl', error: 'bad', hasCode: false }));
  assert.doesNotThrow(() => assertToolEventShape({ type: 'tool_event', toolSessionId: 'tool', event: { type: 'message.updated' } }, { toolSessionId: 'tool', eventType: 'message.updated' }));
  assert.doesNotThrow(() => assertNoSuccessMessageOnInvalidInput([{ type: 'tool_error', error: 'bad' }]));

  const recorder = createMessageRecorder();
  recorder.send({ type: 'tool_event' });
  await waitFor(async () => recorder.messages.length === 1, 100, 10);
  assert.strictEqual(recorder.messages[0].type, 'tool_event');

  const gateway = createMockGateway({ port: 9999 });
  const startResult = await gateway.start();
  assert.deepStrictEqual(startResult, { port: 9999, connected: true });
  await gateway.stop();
});
