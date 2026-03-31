import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { OpencodeSessionGatewayAdapter } from '../../src/adapter/OpencodeSessionGatewayAdapter.ts';

function createLoggerSpy() {
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
      getTraceId: () => 'trace-test',
    },
  };
}

describe('OpencodeSessionGatewayAdapter.promptSession', () => {
  test('returns session_not_found evidence when session.get reports NotFoundError', async () => {
    const calls = { get: 0, prompt: 0 };
    const { logger, entries } = createLoggerSpy();
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => {
          calls.get += 1;
          return {
            error: {
              name: 'NotFoundError',
              data: { message: 'Session not found: ses-missing' },
            },
          };
        },
        prompt: async () => {
          calls.prompt += 1;
          return {};
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-missing',
      text: 'hello',
      logger,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorEvidence?.sourceErrorCode, 'session_not_found');
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.get');
    assert.strictEqual(calls.get, 1);
    assert.strictEqual(calls.prompt, 0);
    assert.deepStrictEqual(entries[0], {
      level: 'warn',
      message: 'session_gateway.session_get.not_found',
      extra: {
        toolSessionId: 'ses-missing',
        errorDetail: '{"name":"NotFoundError","data":{"message":"Session not found: ses-missing"}}',
        errorName: 'NotFoundError',
        rawType: 'Object',
      },
    });
  });

  test('returns failure when session.get error is not NotFoundError', async () => {
    const calls = { get: 0, prompt: 0 };
    const { logger, entries } = createLoggerSpy();
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => {
          calls.get += 1;
          return {
            error: {
              name: 'UnknownError',
              data: { message: 'temporary failure' },
            },
          };
        },
        prompt: async () => {
          calls.prompt += 1;
          return {};
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-any',
      text: 'hello',
      logger,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorMessage, 'Failed to send message: {"name":"UnknownError","data":{"message":"temporary failure"}}');
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.get');
    assert.strictEqual(calls.get, 1);
    assert.strictEqual(calls.prompt, 0);
    assert.deepStrictEqual(entries[0], {
      level: 'warn',
      message: 'session_gateway.session_get.failed',
      extra: {
        toolSessionId: 'ses-any',
        errorDetail: '{"name":"UnknownError","data":{"message":"temporary failure"}}',
        errorName: 'UnknownError',
        rawType: 'Object',
      },
    });
  });

  test('returns session_not_found evidence when session.get throws NotFoundError', async () => {
    const calls = { get: 0, prompt: 0 };
    const { logger, entries } = createLoggerSpy();
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => {
          calls.get += 1;
          throw {
            name: 'NotFoundError',
            data: { message: 'Session not found: ses-throw' },
          };
        },
        prompt: async () => {
          calls.prompt += 1;
          return {};
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-throw',
      text: 'hello',
      logger,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorEvidence?.sourceErrorCode, 'session_not_found');
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.get');
    assert.strictEqual(calls.get, 1);
    assert.strictEqual(calls.prompt, 0);
    assert.deepStrictEqual(entries[0], {
      level: 'warn',
      message: 'session_gateway.session_get.not_found',
      extra: {
        toolSessionId: 'ses-throw',
        errorDetail: '{"name":"NotFoundError","data":{"message":"Session not found: ses-throw"}}',
        errorName: 'NotFoundError',
        rawType: 'Object',
      },
    });
  });

  test('returns failure when session.get throws non-not-found error and logs it', async () => {
    const calls = { get: 0, prompt: 0 };
    const { logger, entries } = createLoggerSpy();
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => {
          calls.get += 1;
          throw new Error('session lookup timed out');
        },
        prompt: async () => {
          calls.prompt += 1;
          return {
            error: {
              code: 'session_not_found',
              statusCode: 404,
              message: 'prompt path says session missing',
            },
          };
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-any',
      text: 'hello',
      logger,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorMessage, 'Failed to send message: session lookup timed out');
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.get');
    assert.strictEqual(result.errorEvidence?.sourceErrorCode, undefined);
    assert.strictEqual(calls.get, 1);
    assert.strictEqual(calls.prompt, 0);
    assert.deepStrictEqual(entries[0], {
      level: 'warn',
      message: 'session_gateway.session_get.failed',
      extra: {
        toolSessionId: 'ses-any',
        errorDetail: 'session lookup timed out',
        errorName: 'Error',
        errorType: 'Error',
        rawType: 'Error',
      },
    });
  });
});
