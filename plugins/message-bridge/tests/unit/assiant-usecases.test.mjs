import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ResolveCreateSessionDirectoryUseCase } from '../../src/usecase/ResolveCreateSessionDirectoryUseCase.ts';
import { CreateSessionUseCase } from '../../src/usecase/CreateSessionUseCase.ts';
import { ChatUseCase } from '../../src/usecase/ChatUseCase.ts';

describe('assiant use cases', () => {
  test('resolves mapped directory when channel is assiant', async () => {
    const mappingCalls = [];
    const useCase = new ResolveCreateSessionDirectoryUseCase(
      {
        getChannel: () => 'assiant',
        isAssiantChannel: () => true,
      },
      {
        resolveDirectory: async (assiantId) => {
          mappingCalls.push(assiantId);
          return '/mapped/tenant-a';
        },
      },
    );

    const result = await useCase.execute({
      assiantId: 'tenant-a',
      effectiveDirectory: '/fallback',
    });

    assert.deepStrictEqual(mappingCalls, ['tenant-a']);
    assert.deepStrictEqual(result, {
      directory: '/mapped/tenant-a',
      source: 'mapping',
    });
  });

  test('falls back to effectiveDirectory when channel is not assiant', async () => {
    let mappingCalled = false;
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
    );

    const result = await useCase.execute({
      assiantId: 'tenant-b',
      effectiveDirectory: '/fallback',
    });

    assert.strictEqual(mappingCalled, false);
    assert.deepStrictEqual(result, {
      directory: '/fallback',
      source: 'effective',
    });
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

  test('chat use case forwards assiantId as agent and keeps effectiveDirectory', async () => {
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
      effectiveDirectory: '/bridge/root',
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls, [
      {
        sessionId: 'tool-chat-1',
        text: 'hello',
        directory: '/bridge/root',
        agent: 'persona-7',
      },
    ]);
  });
});

