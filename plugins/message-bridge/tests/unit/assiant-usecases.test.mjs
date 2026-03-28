import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ResolveCreateSessionDirectoryUseCase } from '../../src/usecase/ResolveCreateSessionDirectoryUseCase.ts';
import { CreateSessionUseCase } from '../../src/usecase/CreateSessionUseCase.ts';
import { ChatUseCase } from '../../src/usecase/ChatUseCase.ts';

function createLoggerRecorder() {
  const calls = [];
  const logger = {
    debug: (message, extra) => calls.push({ level: 'debug', message, extra }),
    info: (message, extra) => calls.push({ level: 'info', message, extra }),
    warn: (message, extra) => calls.push({ level: 'warn', message, extra }),
    error: (message, extra) => calls.push({ level: 'error', message, extra }),
    child: () => logger,
    getTraceId: () => 'test-trace-id',
  };

  return { calls, logger };
}

describe('assiant use cases', () => {
  test('resolves mapped directory when channel is uniassistant', async () => {
    const mappingCalls = [];
    const { calls, logger } = createLoggerRecorder();
    const useCase = new ResolveCreateSessionDirectoryUseCase(
      {
        getChannel: () => 'uniassistant',
        isAssiantChannel: () => true,
      },
      {
        resolveDirectory: async (assiantId) => {
          mappingCalls.push(assiantId);
          return '/mapped/tenant-a';
        },
      },
      logger,
    );

    const result = await useCase.execute({
      assiantId: 'tenant-a',
      effectiveDirectory: '/fallback',
      mappingConfigured: true,
    });

    assert.deepStrictEqual(mappingCalls, ['tenant-a']);
    assert.strictEqual(calls.some((call) => call.message === 'assiant.directory_map.unresolved'), false);
    assert.deepStrictEqual(result, {
      directory: '/mapped/tenant-a',
      source: 'mapping',
    });
  });

  test('falls back to effectiveDirectory when channel is not assiant', async () => {
    let mappingCalled = false;
    const { calls, logger } = createLoggerRecorder();
    const useCase = new ResolveCreateSessionDirectoryUseCase(
      {
        getChannel: () => 'opencode',
        isAssiantChannel: () => false,
      },
      {
        resolveDirectory: async () => {
          mappingCalled = true;
          return '/mapped/tenant-b';
        },
      },
      logger,
    );

    const result = await useCase.execute({
      assiantId: 'tenant-b',
      effectiveDirectory: '/fallback',
      mappingConfigured: true,
    });

    assert.strictEqual(mappingCalled, false);
    assert.strictEqual(calls.some((call) => call.message === 'assiant.directory_map.unresolved'), false);
    assert.deepStrictEqual(result, {
      directory: '/fallback',
      source: 'effective',
    });
  });

  test('warns when mapping file is not configured for uniassistant', async () => {
    const { calls, logger } = createLoggerRecorder();
    const useCase = new ResolveCreateSessionDirectoryUseCase(
      {
        getChannel: () => 'uniassistant',
        isAssiantChannel: () => true,
      },
      {
        resolveDirectory: async () => {
          throw new Error('should not resolve when map is not configured');
        },
      },
      logger,
    );

    const result = await useCase.execute({
      assiantId: 'tenant-unconfigured',
      effectiveDirectory: '/fallback',
      mappingConfigured: false,
    });

    assert.deepStrictEqual(result, {
      directory: '/fallback',
      source: 'effective',
    });
    assert.deepStrictEqual(
      calls.filter((call) => call.message === 'assiant.directory_map.unresolved').map((call) => call.extra),
      [
        {
          reason: 'mapping_file_unconfigured',
          channel: 'uniassistant',
          assiantId: 'tenant-unconfigured',
          mappingConfigured: false,
          hasEffectiveDirectory: true,
          fallbackSource: 'effective',
        },
      ],
    );
  });

  test('warns when assiantId is missing for uniassistant mapping flow', async () => {
    const { calls, logger } = createLoggerRecorder();
    const useCase = new ResolveCreateSessionDirectoryUseCase(
      {
        getChannel: () => 'uniassistant',
        isAssiantChannel: () => true,
      },
      {
        resolveDirectory: async () => {
          throw new Error('should not resolve when assiantId is missing');
        },
      },
      logger,
    );

    const result = await useCase.execute({
      effectiveDirectory: '/fallback',
      mappingConfigured: true,
    });

    assert.deepStrictEqual(result, {
      directory: '/fallback',
      source: 'effective',
    });
    assert.deepStrictEqual(
      calls.filter((call) => call.message === 'assiant.directory_map.unresolved').map((call) => call.extra),
      [
        {
          reason: 'missing_assiant_id',
          channel: 'uniassistant',
          assiantId: undefined,
          mappingConfigured: true,
          hasEffectiveDirectory: true,
          fallbackSource: 'effective',
        },
      ],
    );
  });

  test('warns when assiantId exists but no valid mapped directory is resolved', async () => {
    const { calls, logger } = createLoggerRecorder();
    const useCase = new ResolveCreateSessionDirectoryUseCase(
      {
        getChannel: () => 'uniassistant',
        isAssiantChannel: () => true,
      },
      {
        resolveDirectory: async () => undefined,
      },
      logger,
    );

    const result = await useCase.execute({
      assiantId: 'tenant-miss',
      effectiveDirectory: '/fallback',
      mappingConfigured: true,
    });

    assert.deepStrictEqual(result, {
      directory: '/fallback',
      source: 'effective',
    });
    assert.deepStrictEqual(
      calls.filter((call) => call.message === 'assiant.directory_map.unresolved').map((call) => call.extra),
      [
        {
          reason: 'directory_unresolved',
          channel: 'uniassistant',
          assiantId: 'tenant-miss',
          mappingConfigured: true,
          hasEffectiveDirectory: true,
          fallbackSource: 'effective',
        },
      ],
    );
  });

  test('create session use case uses resolved directory before gateway call', async () => {
    const calls = [];
    const createSessionUseCase = new CreateSessionUseCase(
      {
        execute: async () => ({
          directory: '/mapped/tenant-c',
          source: 'mapping',
        }),
      },
      {
        createSession: async (parameters) => {
          calls.push(parameters);
          return {
            success: true,
            data: {
              sessionId: 'created-1',
              session: { sessionId: 'created-1' },
            },
          };
        },
        promptSession: async () => ({
          success: true,
        }),
      },
    );

    const result = await createSessionUseCase.execute({
      payload: {
        title: 'tenant session',
        assiantId: 'tenant-c',
      },
      effectiveDirectory: '/fallback',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls, [
      {
        title: 'tenant session',
        directory: '/mapped/tenant-c',
      },
    ]);
  });

  test('chat use case forwards assiantId as agent without directory', async () => {
    const calls = [];
    const chatUseCase = new ChatUseCase({
      createSession: async () => ({ success: true, data: { sessionId: 'ignored', session: {} } }),
      promptSession: async (parameters) => {
        calls.push(parameters);
        return { success: true };
      },
    });

    const result = await chatUseCase.execute({
      payload: {
        toolSessionId: 'tool-chat-1',
        text: 'hello',
        assiantId: 'persona-7',
      },
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls, [
      {
        sessionId: 'tool-chat-1',
        text: 'hello',
        agent: 'persona-7',
      },
    ]);
  });
});
