import assert from 'node:assert/strict';

function assertNoField(message, fieldName) {
  assert.strictEqual(fieldName in message, false, `${fieldName} should be absent`);
}

export function assertToolDoneShape(message, expected = {}) {
  assert.strictEqual(message.type, 'tool_done');
  if ('welinkSessionId' in expected) assert.strictEqual(message.welinkSessionId, expected.welinkSessionId);
  if ('toolSessionId' in expected) assert.strictEqual(message.toolSessionId, expected.toolSessionId);
  if ('reason' in expected) assert.strictEqual(message.reason, expected.reason);
}

export function assertSessionCreatedShape(message, expected = {}) {
  assert.strictEqual(message.type, 'session_created');
  if ('welinkSessionId' in expected) assert.strictEqual(message.welinkSessionId, expected.welinkSessionId);
  if ('toolSessionId' in expected) assert.strictEqual(message.toolSessionId, expected.toolSessionId);
}

export function assertStatusResponseShape(message, expected = {}) {
  assert.strictEqual(message.type, 'status_response');
  if ('opencodeOnline' in expected) assert.strictEqual(message.opencodeOnline, expected.opencodeOnline);
  if (expected.envelopeFree === true) {
    assertNoField(message, 'welinkSessionId');
    assertNoField(message, 'sessionId');
  }
}

export function assertToolErrorShape(message, expected = {}) {
  assert.strictEqual(message.type, 'tool_error');
  if ('welinkSessionId' in expected) assert.strictEqual(message.welinkSessionId, expected.welinkSessionId);
  if ('toolSessionId' in expected) assert.strictEqual(message.toolSessionId, expected.toolSessionId);
  if ('error' in expected) assert.strictEqual(message.error, expected.error);
  if ('reason' in expected) assert.strictEqual(message.reason, expected.reason);
  if ('hasCode' in expected) {
    assert.strictEqual('code' in message, expected.hasCode);
  }
}

export function assertToolEventShape(message, expected = {}) {
  assert.strictEqual(message.type, 'tool_event');
  if ('toolSessionId' in expected) assert.strictEqual(message.toolSessionId, expected.toolSessionId);
  if ('eventType' in expected) assert.strictEqual(message.event?.type, expected.eventType);
}

export function assertNoSuccessMessageOnInvalidInput(messages) {
  const successTypes = new Set(['tool_done', 'status_response', 'session_created']);
  assert.strictEqual(messages.some((message) => successTypes.has(message?.type)), false);
}
