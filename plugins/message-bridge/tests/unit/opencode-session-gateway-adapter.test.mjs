import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { OpencodeSessionGatewayAdapter } from '../../src/adapter/OpencodeSessionGatewayAdapter.ts';

function createPromptResponse(overrides = {}) {
  return {
    data: {
      info: {
        id: 'msg-assistant-1',
        cost: 0.12,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 3,
          cache: {
            read: 0,
            write: 0,
          },
        },
        ...overrides.info,
      },
      parts: overrides.parts ?? [{ type: 'step-finish' }],
    },
  };
}

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
  test('createSession returns wrapped Session id from data.id', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async (options) => ({
          data: {
            id: 'ses-create',
            title: options?.title ?? 'created session',
            directory: options?.directory ?? '/tmp/create-dir',
          },
        }),
        get: async () => ({ data: { id: 'unused', directory: '/tmp/unused' } }),
        prompt: async () => ({ data: { ok: true } }),
        abort: async () => ({ data: { ok: true } }),
        delete: async () => ({ data: { ok: true } }),
      },
      postSessionIdPermissionsPermissionId: async () => ({ data: { ok: true } }),
      _client: {
        get: async () => ({ data: [] }),
        post: async () => ({ data: true }),
      },
    }));

    const result = await adapter.createSession({
      title: 'created session',
      directory: '/tmp/create-dir',
    });

    assert.deepStrictEqual(result, {
      success: true,
      data: {
        sessionId: 'ses-create',
        session: {
          id: 'ses-create',
          title: 'created session',
          directory: '/tmp/create-dir',
        },
      },
    });
  });

  test('forwards explicit directory to session.prompt after session.get preflight', async () => {
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
          return createPromptResponse();
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
      directory: '/tmp/explicit-dir',
      agent: 'persona-1',
      logger,
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data.terminal, { kind: 'completed' });
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
          directory: '/tmp/explicit-dir',
          parts: [{ type: 'text', text: 'hello' }],
          agent: 'persona-1',
        },
      },
    ]);
    assert.deepStrictEqual(entries, [
      {
        level: 'debug',
        message: 'session_lookup.session_get.succeeded',
        extra: {
          toolSessionId: 'ses-ok',
          hasDirectory: true,
          hasAgent: true,
        },
      },
      {
        level: 'debug',
        message: 'session_prompt.request.prepared',
        extra: {
          sessionId: 'ses-ok',
          directory: '/tmp/explicit-dir',
          providerID: undefined,
          modelID: undefined,
          hasAgent: true,
        },
      },
    ]);
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
      message: 'session_lookup.session_get.not_found',
      extra: {
        toolSessionId: 'ses-missing',
        errorDetail: '{"name":"NotFoundError","data":{"message":"Session not found: ses-missing"}}',
        errorName: 'NotFoundError',
        hasAgent: false,
        rawType: 'Object',
      },
    });
  });

  test('allows prompt when session.get succeeds without directory', async () => {
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
          return createPromptResponse();
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

    assert.strictEqual(result.success, true);
    assert.strictEqual(calls.get, 1);
    assert.strictEqual(calls.prompt, 1);
    assert.deepStrictEqual(entries, [{
      level: 'debug',
      message: 'session_lookup.session_get.succeeded',
      extra: {
        toolSessionId: 'ses-no-dir',
        hasDirectory: false,
        hasAgent: false,
      },
    }, {
      level: 'debug',
      message: 'session_prompt.request.prepared',
      extra: {
        sessionId: 'ses-no-dir',
        directory: undefined,
        providerID: undefined,
        modelID: undefined,
        hasAgent: false,
      },
    }]);
  });

  test('lists OpenCode native commands only when command.list and session.command are available', async () => {
    const calls = [];
    const { logger } = createLoggerSpy();
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => ({ data: { id: 'unused' } }),
        prompt: async () => createPromptResponse(),
        command: async () => createPromptResponse(),
      },
      command: {
        list: async (options) => {
          calls.push(options);
          return { data: [{ name: 'init' }, { id: 'review' }, 'compact'] };
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.listNativeCommands({
      directory: '/workspace/native',
      logger,
    });

    assert.deepStrictEqual(result, {
      success: true,
      data: {
        commands: [{ name: 'init' }, { name: 'review' }, { name: 'compact' }],
      },
    });
    assert.deepStrictEqual(calls, [{ directory: '/workspace/native' }]);
  });

  test('executes OpenCode native command through session.command without prompt fallback', async () => {
    const calls = [];
    const { logger } = createLoggerSpy();
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => ({ data: { id: 'unused' } }),
        prompt: async () => {
          calls.push({ type: 'prompt' });
          return createPromptResponse();
        },
        command: async (options) => {
          calls.push({ type: 'command', options });
          return createPromptResponse();
        },
      },
      command: {
        list: async () => ({ data: [] }),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.commandSession({
      sessionId: 'ses-command',
      commandName: 'init',
      arguments: 'project now',
      directory: '/workspace/native',
      agent: 'build',
      modelOverride: { providerId: 'test', modelId: 'test-model' },
      logger,
    });

    assert.equal(result.success, true);
    assert.deepStrictEqual(Object.keys(result.data).sort(), ['message']);
    assert.equal(result.data.message.info.id, 'msg-assistant-1');
    assert.deepStrictEqual(calls, [{
      type: 'command',
      options: {
        sessionID: 'ses-command',
        command: 'init',
        arguments: 'project now',
        directory: '/workspace/native',
        model: 'test/test-model',
        agent: 'build',
      },
    }]);
  });

  test('passes empty string arguments when OpenCode native command has no arguments', async () => {
    const calls = [];
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => ({ data: { id: 'unused' } }),
        prompt: async () => createPromptResponse(),
        command: async (options) => {
          calls.push(options);
          return createPromptResponse();
        },
      },
      command: {
        list: async () => ({ data: [] }),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.commandSession({
      sessionId: 'ses-command-empty-args',
      commandName: 'init',
    });

    assert.equal(result.success, true);
    assert.deepStrictEqual(calls, [{
      sessionID: 'ses-command-empty-args',
      command: 'init',
      arguments: '',
    }]);
  });

  test('keeps bare APIError terminal when assistant info.error only provides name', async () => {
    const { logger, entries } = createLoggerSpy();
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => ({
          data: {
            id: 'ses-api-error-name-only',
            directory: '/tmp/session-dir',
          },
        }),
        prompt: async () => createPromptResponse({
          info: {
            error: {
              name: 'APIError',
            },
          },
        }),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-api-error-name-only',
      text: 'hello',
      logger,
    });

    assert.deepStrictEqual(result, {
      success: true,
      data: {
        message: {
          info: {
            id: 'msg-assistant-1',
            error: {
              name: 'APIError',
            },
            cost: 0.12,
            tokens: {
              input: 10,
              output: 20,
              reasoning: 3,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
          parts: [],
        },
        terminal: {
          kind: 'failed',
          errorCode: 'internal_error',
          errorMessage: 'APIError',
          errorDetails: {
            name: 'APIError',
          },
        },
      },
    });
    assert.deepStrictEqual(
      entries.find((entry) => entry.message === 'session_prompt.assistant_error.normalized'),
      {
        level: 'debug',
        message: 'session_prompt.assistant_error.normalized',
        extra: {
          toolSessionId: 'ses-api-error-name-only',
          rawErrorName: 'APIError',
          rawDataHasMessage: false,
          rawDataStatusCode: undefined,
          rawDataIsRetryable: undefined,
          normalizedErrorName: 'APIError',
          normalizedHasMessage: false,
          normalizedStatusCode: undefined,
          normalizedIsRetryable: undefined,
        },
      },
    );
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
      message: 'session_lookup.session_get.failed',
      extra: {
        toolSessionId: 'ses-any',
        errorDetail: '{"name":"UnknownError","data":{"message":"temporary failure"}}',
        errorName: 'UnknownError',
        hasAgent: false,
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
      message: 'session_lookup.session_get.not_found',
      extra: {
        toolSessionId: 'ses-throw',
        errorDetail: '{"name":"NotFoundError","data":{"message":"Session not found: ses-throw"}}',
        errorName: 'NotFoundError',
        hasAgent: false,
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
      message: 'session_lookup.session_get.failed',
      extra: {
        toolSessionId: 'ses-any',
        errorDetail: 'session lookup timed out',
        errorName: 'Error',
        errorType: 'Error',
        hasAgent: false,
        rawType: 'Error',
      },
    });
  });

  test('returns failure when session.prompt rejects after preflight', async () => {
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
    assert.deepStrictEqual(entries, [{
      level: 'debug',
      message: 'session_lookup.session_get.succeeded',
      extra: {
        toolSessionId: 'ses-prompt-fail',
        hasDirectory: true,
        hasAgent: false,
      },
    }, {
      level: 'debug',
      message: 'session_prompt.request.prepared',
      extra: {
        sessionId: 'ses-prompt-fail',
        directory: undefined,
        providerID: undefined,
        modelID: undefined,
        hasAgent: false,
      },
    }]);
  });

  test('returns payload failure with session.prompt sourceOperation', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => ({
          data: {
            id: 'ses-prompt-payload-fail',
            directory: '/tmp/prompt-payload-fail',
          },
        }),
        prompt: async () => ({
          error: {
            name: 'PromptFailed',
            data: { message: 'prompt payload failed' },
          },
        }),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-prompt-payload-fail',
      text: 'hello',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(
      result.errorMessage,
      'Failed to send message: {"name":"PromptFailed","data":{"message":"prompt payload failed"}}',
    );
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.prompt');
  });

  test('maps MessageAbortedError in prompt response to aborted terminal', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => ({
          data: {
            id: 'ses-aborted',
            directory: '/tmp/aborted-dir',
          },
        }),
        prompt: async () => createPromptResponse({
          info: {
            error: {
              name: 'MessageAbortedError',
              data: {
                message: 'User aborted',
              },
            },
          },
        }),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-aborted',
      text: 'hello',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data.terminal, { kind: 'aborted' });
  });

  test('maps assistant info.error in prompt response to failed terminal', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => ({
          data: {
            id: 'ses-failed',
            directory: '/tmp/failed-dir',
          },
        }),
        prompt: async () => createPromptResponse({
          info: {
            error: {
              name: 'APIError',
              data: {
                message: 'model backend failed',
                statusCode: 429,
                isRetryable: true,
                responseBody: 'Too many requests',
              },
            },
          },
        }),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-failed',
      text: 'hello',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data.terminal, {
      kind: 'failed',
      errorCode: 'internal_error',
      errorMessage: 'APIError: model backend failed statusCode=429',
      errorDetails: {
        name: 'APIError',
        message: 'model backend failed',
        statusCode: 429,
        isRetryable: true,
        responseBody: 'Too many requests',
      },
    });
  });

  test('keeps legacy top-level assistant error fields compatible in prompt response', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => ({
          data: {
            id: 'ses-failed-legacy-error',
            directory: '/tmp/failed-legacy-dir',
          },
        }),
        prompt: async () => createPromptResponse({
          info: {
            error: {
              name: 'APIError',
              message: 'legacy backend failed',
              statusCode: 429,
              retryable: true,
              providerID: 'openai',
            },
          },
        }),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-failed-legacy-error',
      text: 'hello',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data.terminal, {
      kind: 'failed',
      errorCode: 'internal_error',
      errorMessage: 'APIError: legacy backend failed statusCode=429',
      errorDetails: {
        name: 'APIError',
        message: 'legacy backend failed',
        statusCode: 429,
        retryable: true,
        providerID: 'openai',
      },
    });
  });

  test('maps StructuredOutputError data.message in prompt response to failed terminal', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => ({
          data: {
            id: 'ses-structured-error',
            directory: '/tmp/structured-error-dir',
          },
        }),
        prompt: async () => createPromptResponse({
          info: {
            error: {
              name: 'StructuredOutputError',
              data: {
                message: 'json schema validation failed',
                retries: 2,
              },
            },
          },
        }),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-structured-error',
      text: 'hello',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data.terminal, {
      kind: 'failed',
      errorCode: 'internal_error',
      errorMessage: 'StructuredOutputError: json schema validation failed',
      errorDetails: {
        name: 'StructuredOutputError',
        message: 'json schema validation failed',
        retries: 2,
      },
    });
  });

  test('maps UnknownError data.message in prompt response to failed terminal', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => ({
          data: {
            id: 'ses-unknown-error',
            directory: '/tmp/unknown-error-dir',
          },
        }),
        prompt: async () => createPromptResponse({
          info: {
            error: {
              name: 'UnknownError',
              data: {
                message: 'temporary failure',
              },
            },
          },
        }),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-unknown-error',
      text: 'hello',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data.terminal, {
      kind: 'failed',
      errorCode: 'internal_error',
      errorMessage: 'UnknownError: temporary failure',
      errorDetails: {
        name: 'UnknownError',
        message: 'temporary failure',
      },
    });
  });
});

describe('OpencodeSessionGatewayAdapter session-scoped actions', () => {
  test('promptSession preflights session.get and omits directory when none is provided', async () => {
    const calls = [];
    const { logger, entries } = createLoggerSpy();
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => {
          calls.push({ type: 'get' });
          return { data: { id: 'ses-openx', directory: '/tmp/should-not-use' } };
        },
        prompt: async (options) => {
          calls.push({ type: 'prompt', options });
          return createPromptResponse();
        },
        abort: async () => ({}),
        delete: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: { get: async () => ({}), post: async () => ({}) },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-openx',
      text: 'hello',
      logger,
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data.terminal, { kind: 'completed' });
    assert.deepStrictEqual(calls, [
      {
        type: 'get',
      },
      {
        type: 'prompt',
        options: {
          sessionID: 'ses-openx',
          parts: [{ type: 'text', text: 'hello' }],
        },
      },
    ]);
    assert.deepStrictEqual(entries, [
      {
        level: 'debug',
        message: 'session_lookup.session_get.succeeded',
        extra: {
          toolSessionId: 'ses-openx',
          hasDirectory: true,
          hasAgent: false,
        },
      },
      {
        level: 'debug',
        message: 'session_prompt.request.prepared',
        extra: {
          sessionId: 'ses-openx',
          directory: undefined,
          providerID: undefined,
          modelID: undefined,
          hasAgent: false,
        },
      },
    ]);
  });

  test('replyQuestion does not depend on directory policy', async () => {
    const postCalls = [];
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-openx-question', directory: '/tmp/should-not-use' } }),
        abort: async () => ({}),
        delete: async () => ({}),
        prompt: async () => ({}),
      },
      question: {
        reply: async (options) => {
          postCalls.push(options);
          return { data: undefined };
        },
      },
    }));

    const result = await adapter.replyQuestion({
      questionId: 'question-request-openx-1',
      answers: [['yes']],
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(postCalls, [
      {
        questionId: 'question-request-openx-1',
        answers: [['yes']],
      },
    ]);
  });

  test('abortSession forwards only sessionID to session.abort', async () => {
    const calls = [];
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
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
      { sessionID: 'ses-abort' },
    ]);
  });

  test('abortSession returns payload failure with session.abort sourceOperation', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-abort-payload-fail', directory: '/tmp/abort-dir' } }),
        abort: async () => ({
          error: {
            name: 'AbortFailed',
            data: { message: 'abort payload failed' },
          },
        }),
        delete: async () => ({}),
        prompt: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: { get: async () => ({}), post: async () => ({}) },
    }));

    const result = await adapter.abortSession({ sessionId: 'ses-abort-payload-fail' });

    assert.strictEqual(result.success, false);
    assert.strictEqual(
      result.errorMessage,
      'Failed to abort session: {"name":"AbortFailed","data":{"message":"abort payload failed"}}',
    );
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.abort');
  });

  test('closeSession forwards only sessionID to session.delete', async () => {
    const calls = [];
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
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
      { sessionID: 'ses-close' },
    ]);
  });

  test('closeSession returns payload failure with session.delete sourceOperation', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-close-payload-fail', directory: '/tmp/close-dir' } }),
        abort: async () => ({}),
        delete: async () => ({
          error: {
            name: 'DeleteFailed',
            data: { message: 'close payload failed' },
          },
        }),
        prompt: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: { get: async () => ({}), post: async () => ({}) },
    }));

    const result = await adapter.closeSession({ sessionId: 'ses-close-payload-fail' });

    assert.strictEqual(result.success, false);
    assert.strictEqual(
      result.errorMessage,
      'Failed to close session: {"name":"DeleteFailed","data":{"message":"close payload failed"}}',
    );
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.delete');
  });

  test('replyPermission forwards permissionId to permission reply endpoint', async () => {
    const permissionCalls = [];
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-perm', directory: '/tmp/perm-dir' } }),
        abort: async () => ({}),
        delete: async () => ({}),
        prompt: async () => ({}),
      },
      permission: {
        reply: async (options) => {
          permissionCalls.push(options);
          return { data: { ok: true } };
        },
      },
    }));

    const result = await adapter.replyPermission({
      permissionId: 'perm-1',
      response: 'always',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, {
      permissionId: 'perm-1',
      response: 'always',
      applied: true,
    });
    assert.deepStrictEqual(permissionCalls, [
      {
        permissionId: 'perm-1',
        response: 'always',
      },
    ]);
  });

  test('replyPermission returns payload failure with permission.reply sourceOperation', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-perm-payload-fail', directory: '/tmp/perm-dir' } }),
        abort: async () => ({}),
        delete: async () => ({}),
        prompt: async () => ({}),
      },
      permission: {
        reply: async () => ({
          error: {
            name: 'PermissionFailed',
            data: { message: 'permission payload failed' },
          },
        }),
      },
    }));

    const result = await adapter.replyPermission({
      permissionId: 'perm-1',
      response: 'always',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(
      result.errorMessage,
      'Failed to reply to permission request: {"name":"PermissionFailed","data":{"message":"permission payload failed"}}',
    );
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'permission.reply');
  });

  test('replyQuestion forwards questionId to question reply endpoint', async () => {
    const questionCalls = [];
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-question', directory: '/tmp/question-dir' } }),
        abort: async () => ({}),
        delete: async () => ({}),
        prompt: async () => ({}),
      },
      question: {
        reply: async (options) => {
          questionCalls.push(options);
          return { data: undefined };
        },
      },
    }));

    const result = await adapter.replyQuestion({
      questionId: 'question-request-1',
      answers: [['yes'], ['A', 'B']],
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, { requestId: 'question-request-1', replied: true });
    assert.deepStrictEqual(questionCalls, [
      {
        questionId: 'question-request-1',
        answers: [['yes'], ['A', 'B']],
      },
    ]);
  });

  test('replyQuestion returns payload failure with question.reply sourceOperation', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-question-list-fail', directory: '/tmp/question-dir' } }),
        abort: async () => ({}),
        delete: async () => ({}),
        prompt: async () => ({}),
      },
      question: {
        reply: async () => ({
          error: {
            name: 'QuestionReplyFailed',
            data: { message: 'question reply failed' },
          },
        }),
      },
    }));

    const result = await adapter.replyQuestion({
      questionId: 'question-request-1',
      answers: [['yes']],
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(
      result.errorMessage,
      'Failed to reply to question: {"name":"QuestionReplyFailed","data":{"message":"question reply failed"}}',
    );
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'question.reply');
  });

  test('replyQuestion returns payload failure with question.reply sourceOperation', async () => {
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        get: async () => ({ data: { id: 'ses-question-reply-fail', directory: '/tmp/question-dir' } }),
        abort: async () => ({}),
        delete: async () => ({}),
        prompt: async () => ({}),
      },
      question: {
        reply: async () => ({
          error: {
            name: 'QuestionReplyFailed',
            data: { message: 'question reply failed' },
          },
        }),
      },
    }));

    const result = await adapter.replyQuestion({
      questionId: 'question-request-1',
      answers: [['yes']],
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(
      result.errorMessage,
      'Failed to reply to question: {"name":"QuestionReplyFailed","data":{"message":"question reply failed"}}',
    );
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'question.reply');
  });
});
