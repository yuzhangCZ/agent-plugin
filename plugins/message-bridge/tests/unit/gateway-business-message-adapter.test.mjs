import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { adaptGatewayBusinessMessage } from '../../src/protocol/downstream/GatewayBusinessMessageAdapter.ts';

describe('gateway business message adapter', () => {
  test('accepts typed facade question_reply message and preserves normalized payload', () => {
    const result = adaptGatewayBusinessMessage({
      type: 'invoke',
      action: 'question_reply',
      welinkSessionId: 'wl-question-1',
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

  test('rejects create_session facade message without plugin-required welinkSessionId', () => {
    const result = adaptGatewayBusinessMessage({
      type: 'invoke',
      action: 'create_session',
      payload: {
        title: 'missing welink session',
      },
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'missing_required_field');
    assert.strictEqual(result.error.action, 'create_session');
    assert.strictEqual(result.error.field, 'welinkSessionId');
  });
});
