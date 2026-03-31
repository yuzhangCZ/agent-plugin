import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { OpencodeSessionGatewayAdapter } from '../../src/adapter/OpencodeSessionGatewayAdapter.ts';

function createLoggerSpy() {
  const entries = [];
  return {
    entries,
    logger: {
      debug: (message, extra) => entries.push({ level: 'debug', message, extra }),
      info: (message, extra) => entries.push({ level: 'info', message, extra }),
      warn: (message, extra) => entries.push({ level: 'warn', message, extra }),
      error: (message, extra) => entries.push({ level: 'error', message, extra }),
      child() {
        return this;
      },
      getTraceId: () => 'trace-test',
    },
  };
}

describe('OpencodeSessionGatewayAdapter.promptSession', () => {
  test('resolves directory from session.get and forwards it to session.prompt with debug log', async () => {
    const calls = [];
    const { logger, entries } = createLoggerSpy();
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async (options) => {
          calls.push({ type: 'get', options });
          return {
            data: {
              id: 'ses-ok',
              directory: '/tmp/session-dir',
            },
          };
        },
        prompt: async (options) => {
          calls.push({ type: 'prompt', options });
          return { data: { ok: true } };
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-ok',
      text: 'hello',
      agent: 'persona-1',
      logger,
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls, [
      {
        type: 'get',
        options: {
          sessionID: 'ses-ok',
        },
      },
      {
        type: 'prompt',
        options: {
          sessionID: 'ses-ok',
          directory: '/tmp/session-dir',
          parts: [{ type: 'text', text: 'hello' }],
          agent: 'persona-1',
        },
      },
    ]);
    assert.deepStrictEqual(entries[0], {
      level: 'debug',
      message: 'session_directory.session_get.directory_resolved',
      extra: {
        toolSessionId: 'ses-ok',
        directory: '/tmp/session-dir',
        hasAgent: true,
      },
    });
  });

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
      message: 'session_directory.session_get.not_found',
      extra: {
        toolSessionId: 'ses-missing',
        errorDetail: '{"name":"NotFoundError","data":{"message":"Session not found: ses-missing"}}',
        errorName: 'NotFoundError',
        rawType: 'Object',
      },
    });
  });

  test('returns failure when session.get succeeds without directory and logs warning', async () => {
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
            data: {
              id: 'ses-no-dir',
            },
          };
        },
        prompt: async () => {
          calls.prompt += 1;
          return { data: { ok: true } };
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-no-dir',
      text: 'hello',
      logger,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorMessage, 'Failed to send message: session.get returned without directory');
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.get');
    assert.strictEqual(calls.get, 1);
    assert.strictEqual(calls.prompt, 0);
    assert.deepStrictEqual(entries[0], {
      level: 'warn',
      message: 'session_directory.session_get.directory_missing',
      extra: {
        toolSessionId: 'ses-no-dir',
        hasAgent: false,
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
      message: 'session_directory.session_get.failed',
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
      message: 'session_directory.session_get.not_found',
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
      message: 'session_directory.session_get.failed',
      extra: {
        toolSessionId: 'ses-any',
        errorDetail: 'session lookup timed out',
        errorName: 'Error',
        errorType: 'Error',
        rawType: 'Error',
      },
    });
  });

  test('returns failure when session.prompt rejects after directory resolution', async () => {
    const { logger, entries } = createLoggerSpy();
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => ({
          data: {
            id: 'ses-prompt-fail',
            directory: '/tmp/prompt-fail',
          },
        }),
        prompt: async () => {
          throw new Error('prompt transport down');
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-prompt-fail',
      text: 'hello',
      logger,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorMessage, 'Failed to send message: prompt transport down');
    assert.deepStrictEqual(entries[0], {
      level: 'debug',
      message: 'session_directory.session_get.directory_resolved',
      extra: {
        toolSessionId: 'ses-prompt-fail',
        directory: '/tmp/prompt-fail',
        hasAgent: false,
      },
    });
  });
});

describe('OpencodeSessionGatewayAdapter session-scoped actions', () => {
  test('abortSession resolves directory and forwards it to session.abort', async () => {
    const calls = [];
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-abort', directory: '/tmp/abort-dir' } }),
        abort: async (options) => {
          calls.push(options);
          return { data: { aborted: true } };
        },
        delete: async () => ({}),
        prompt: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: { get: async () => ({}), post: async () => ({}) },
    }));

    const result = await adapter.abortSession({ sessionId: 'ses-abort' });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, { sessionId: 'ses-abort', aborted: true });
    assert.deepStrictEqual(calls, [
      { sessionID: 'ses-abort', directory: '/tmp/abort-dir' },
    ]);
  });

  test('closeSession resolves directory and forwards it to session.delete', async () => {
    const calls = [];
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-close', directory: '/tmp/close-dir' } }),
        abort: async () => ({}),
        delete: async (options) => {
          calls.push(options);
          return { data: { deleted: true } };
        },
        prompt: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: { get: async () => ({}), post: async () => ({}) },
    }));

    const result = await adapter.closeSession({ sessionId: 'ses-close' });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, { sessionId: 'ses-close', closed: true });
    assert.deepStrictEqual(calls, [
      { sessionID: 'ses-close', directory: '/tmp/close-dir' },
    ]);
  });

  test('replyPermission resolves directory and forwards it to permission endpoint', async () => {
    const calls = [];
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-perm', directory: '/tmp/perm-dir' } }),
        abort: async () => ({}),
        delete: async () => ({}),
        prompt: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async (options) => {
        calls.push(options);
        return { data: { ok: true } };
      },
      _client: { get: async () => ({}), post: async () => ({}) },
    }));

    const result = await adapter.replyPermission({
      sessionId: 'ses-perm',
      permissionId: 'perm-1',
      response: 'always',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, {
      permissionId: 'perm-1',
      response: 'always',
      applied: true,
    });
    assert.deepStrictEqual(calls, [
      {
        sessionID: 'ses-perm',
        permissionID: 'perm-1',
        response: 'always',
        directory: '/tmp/perm-dir',
      },
    ]);
  });

  test('replyQuestion resolves directory and forwards it to question list and reply', async () => {
    const getCalls = [];
    const postCalls = [];
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-question', directory: '/tmp/question-dir' } }),
        abort: async () => ({}),
        delete: async () => ({}),
        prompt: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async (options) => {
          getCalls.push(options);
          return {
            data: [
              {
                id: 'question-request-1',
                sessionID: 'ses-question',
                tool: { callID: 'call-1' },
              },
            ],
          };
        },
        post: async (options) => {
          postCalls.push(options);
          return { data: undefined };
        },
      },
    }));

    const result = await adapter.replyQuestion({
      sessionId: 'ses-question',
      toolCallId: 'call-1',
      answer: 'yes',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, { requestId: 'question-request-1', replied: true });
    assert.deepStrictEqual(getCalls, [
      {
        url: '/question',
        query: { directory: '/tmp/question-dir' },
      },
    ]);
    assert.deepStrictEqual(postCalls, [
      {
        url: '/question/{requestID}/reply',
        path: { requestID: 'question-request-1' },
        body: { answers: [['yes']] },
        headers: { 'Content-Type': 'application/json' },
        query: { directory: '/tmp/question-dir' },
      },
    ]);
  });
});
