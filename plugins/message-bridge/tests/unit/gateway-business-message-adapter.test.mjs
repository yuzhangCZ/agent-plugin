import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { adaptGatewayBusinessMessage } from '../../src/protocol/downstream/GatewayBusinessMessageAdapter.ts';

describe('gateway business message adapter', () => {
  test('accepts typed facade question_reply message and strips transitional rawPayload', () => {
    const result = adaptGatewayBusinessMessage({
      type: 'invoke',
      action: 'question_reply',
      welinkSessionId: 'wl-question-1',
      rawPayload: {
        toolCallId: 'legacy-call-1',
      },
      payload: {
        toolSessionId: 'tool-question-1',
        toolCallId: 'call-question-1',
        answer: 'approved',
      },
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value, {
      type: 'invoke',
      action: 'question_reply',
      welinkSessionId: 'wl-question-1',
      payload: {
        toolSessionId: 'tool-question-1',
        toolCallId: 'call-question-1',
        answer: 'approved',
      },
    });
  });

  test('backfills optional welinkSessionId for typed facade chat message', () => {
    const result = adaptGatewayBusinessMessage({
      type: 'invoke',
      action: 'chat',
      rawPayload: {
        assistantId: 'persona-legacy',
      },
      payload: {
        toolSessionId: 'tool-chat-1',
        text: 'hello',
      },
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value, {
      type: 'invoke',
      action: 'chat',
      welinkSessionId: undefined,
      payload: {
        toolSessionId: 'tool-chat-1',
        text: 'hello',
      },
    });
  });

  test('preserves required welinkSessionId for typed facade create_session message', () => {
    const result = adaptGatewayBusinessMessage({
      type: 'invoke',
      action: 'create_session',
      welinkSessionId: 'wl-create-1',
      payload: {
        title: 'new session',
      },
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value, {
      type: 'invoke',
      action: 'create_session',
      welinkSessionId: 'wl-create-1',
      payload: {
        title: 'new session',
      },
    });
  });

  test('fails closed for spoofed typed facade invoke action outside supported set', () => {
    const result = adaptGatewayBusinessMessage({
      type: 'invoke',
      action: 'delete_session',
      welinkSessionId: 'wl-invalid-1',
      payload: {},
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'unsupported_action');
    assert.strictEqual(result.error.field, 'action');
    assert.strictEqual(result.error.action, 'delete_session');
    assert.strictEqual(result.error.welinkSessionId, 'wl-invalid-1');
  });
});
