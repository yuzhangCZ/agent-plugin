import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolErrorClassifier } from '../../src/error/ToolErrorClassifier.ts';

describe('ToolErrorClassifier', () => {
  const classifier = new ToolErrorClassifier();

  test('maps sourceErrorCode=session_not_found to session_not_found', () => {
    assert.strictEqual(
      classifier.classify({
        success: false,
        errorCode: 'SDK_UNREACHABLE',
        errorMessage: 'request failed',
        errorEvidence: { sourceErrorCode: 'session_not_found' },
      }, 'chat'),
      'session_not_found',
    );
  });

  test('does not map session_not_found evidence for non-chat actions', () => {
    const nonChatActions = ['close_session', 'create_session', 'status_query', 'abort_session', 'permission_reply', 'question_reply'];

    for (const action of nonChatActions) {
      assert.strictEqual(
        classifier.classify({
          success: false,
          errorCode: 'SDK_UNREACHABLE',
          errorMessage: 'request failed',
          errorEvidence: { sourceErrorCode: 'session_not_found' },
        }, action),
        undefined,
      );
    }
  });

  test('does not infer session_not_found from message text or 404', () => {
    assert.strictEqual(
      classifier.classify({
        success: false,
        errorCode: 'INVALID_PAYLOAD',
        errorMessage: 'session not found',
      }, 'chat'),
      undefined,
    );

    assert.strictEqual(
      classifier.classify({
        success: false,
        errorCode: 'SDK_UNREACHABLE',
        errorMessage: '404 resource not found',
      }, 'chat'),
      undefined,
    );
  });
});
