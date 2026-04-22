import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDownstreamMessage } from '../../src/protocol/downstream/DownstreamMessageNormalizer.ts';

function createLogger() {
  const entries = [];
  return {
    entries,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message, extra) => entries.push({ level: 'warn', message, extra }),
      error: () => {},
      child() {
        return this;
      },
      getTraceId() {
        return 'trace-test';
      },
    },
  };
}

describe('downstream message normalizer', () => {
  test('normalizes status_query message', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'status_query',
      },
      logger,
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value, {
      type: 'status_query',
    });
  });

  test('normalizes invoke/chat payload', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: 'skill-1',
        action: 'chat',
        payload: {
          toolSessionId: 'tool-1',
          text: 'hello',
        },
      },
      logger,
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value, {
      type: 'invoke',
      action: 'chat',
      welinkSessionId: 'skill-1',
      payload: {
        toolSessionId: 'tool-1',
        text: 'hello',
      },
    });
  });

  test('rejects create_session without welinkSessionId via shared schema and logs once', () => {
    const { logger, entries } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        action: 'create_session',
        payload: {
          title: 'missing session',
        },
      },
      logger,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'missing_required_field');
    assert.strictEqual(result.error.field, 'welinkSessionId');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].message, 'downstream.normalization_failed');
  });

  test('normalizes optional assistantId for chat and create_session payloads', () => {
    const { logger } = createLogger();
    const chatResult = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: 'skill-assistant-chat',
        action: 'chat',
        payload: {
          toolSessionId: 'tool-assistant-chat',
          text: 'hello',
          assistantId: ' persona-a ',
        },
      },
      logger,
    );

    assert.strictEqual(chatResult.ok, true);
    assert.deepStrictEqual(chatResult.value.payload, {
      toolSessionId: 'tool-assistant-chat',
      text: 'hello',
      assistantId: 'persona-a',
    });

    const createResult = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: 'skill-assistant-create',
        action: 'create_session',
        payload: {
          title: 'assistant session',
          assistantId: ' persona-b ',
        },
      },
      logger,
    );

    assert.strictEqual(createResult.ok, true);
    assert.deepStrictEqual(createResult.value.payload, {
      title: 'assistant session',
      assistantId: 'persona-b',
    });
  });

  test('normalizes invoke/permission_reply payload', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: 'skill-2',
        action: 'permission_reply',
        payload: {
          permissionId: 'perm-1',
          toolSessionId: 'tool-2',
          response: 'once',
        },
      },
      logger,
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value, {
      type: 'invoke',
      action: 'permission_reply',
      welinkSessionId: 'skill-2',
      payload: {
        permissionId: 'perm-1',
        toolSessionId: 'tool-2',
        response: 'once',
      },
    });
  });

  test('rejects nested invoke payload shape and logs normalization failure', () => {
    const { logger, entries } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: '42',
        payload: {
          action: 'chat',
          payload: { toolSessionId: 'tool-1', text: 'hello' },
        },
      },
      logger,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'unsupported_action');
    assert.strictEqual(result.error.messageType, 'invoke');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].message, 'downstream.normalization_failed');
  });

  test('rejects unsupported invoke action and logs normalization failure', () => {
    const { logger, entries } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: '77',
        action: 'delete_session',
        payload: {},
      },
      logger,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'unsupported_action');
    assert.strictEqual(result.error.action, 'delete_session');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].message, 'downstream.normalization_failed');
  });

  test('rejects invalid permission reply response', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: 'skill-3',
        action: 'permission_reply',
        payload: {
          permissionId: 'perm-3',
          toolSessionId: 'tool-3',
          response: 'allow',
        },
      },
      logger,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'invalid_field_type');
    assert.strictEqual(result.error.field, 'payload.response');
  });

  test('rejects non-string assistantId payload values', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: 'skill-assistant-invalid',
        action: 'chat',
        payload: {
          toolSessionId: 'tool-invalid',
          text: 'hello',
          assistantId: 123,
        },
      },
      logger,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'invalid_field_type');
    assert.strictEqual(result.error.field, 'payload.assistantId');
  });

  test('rejects null assistantId payload values', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: 'skill-assistant-null',
        action: 'create_session',
        payload: {
          title: 'nullable',
          assistantId: null,
        },
      },
      logger,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'invalid_field_type');
    assert.strictEqual(result.error.field, 'payload.assistantId');
  });

  test('rejects invoke/status_query compatibility shape', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: 'status-1',
        action: 'status_query',
        payload: {},
      },
      logger,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'unsupported_action');
    assert.strictEqual(result.error.action, 'status_query');
  });

  test('rejects create_session without welinkSessionId', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        action: 'create_session',
        payload: {},
      },
      logger,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'missing_required_field');
    assert.strictEqual(result.error.action, 'create_session');
    assert.strictEqual(result.error.field, 'welinkSessionId');
  });

  test('rejects blank create_session welinkSessionId', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: '   ',
        action: 'create_session',
        payload: {},
      },
      logger,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'missing_required_field');
    assert.strictEqual(result.error.action, 'create_session');
    assert.strictEqual(result.error.field, 'welinkSessionId');
  });

  test('normalizes create_session title payload and drops empty title', () => {
    const { logger } = createLogger();
    const withTitle = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: 'skill-create-1',
        action: 'create_session',
        payload: {
          title: 'Bridge session',
        },
      },
      logger,
    );

    assert.strictEqual(withTitle.ok, true);
    assert.deepStrictEqual(withTitle.value, {
      type: 'invoke',
      action: 'create_session',
      welinkSessionId: 'skill-create-1',
      payload: {
        title: 'Bridge session',
      },
    });

    const emptyTitle = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: 'skill-create-2',
        action: 'create_session',
        payload: {
          title: '   ',
        },
      },
      logger,
    );
    assert.strictEqual(emptyTitle.ok, true);
    assert.deepStrictEqual(emptyTitle.value.payload, {});
  });

  test('rejects non-string create_session title', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        welinkSessionId: 'skill-create-3',
        action: 'create_session',
        payload: {
          title: 123,
        },
      },
      logger,
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'invalid_field_type');
    assert.strictEqual(result.error.field, 'payload.title');
  });

  test('normalizes invoke/abort_session payload', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        action: 'abort_session',
        payload: {
          toolSessionId: 'tool-42',
        },
      },
      logger,
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value, {
      type: 'invoke',
      action: 'abort_session',
      payload: {
        toolSessionId: 'tool-42',
      },
      welinkSessionId: undefined,
    });
  });

  test('normalizes invoke/question_reply payload', () => {
    const { logger } = createLogger();
    const result = normalizeDownstreamMessage(
      {
        type: 'invoke',
        action: 'question_reply',
        payload: {
          toolSessionId: 'tool-42',
          toolCallId: 'call-7',
          answer: 'approved',
        },
      },
      logger,
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value, {
      type: 'invoke',
      action: 'question_reply',
      payload: {
        toolSessionId: 'tool-42',
        toolCallId: 'call-7',
        answer: 'approved',
      },
      welinkSessionId: undefined,
    });
  });
});
