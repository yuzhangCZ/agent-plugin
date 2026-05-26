import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultChatCommandUseCase } from '../../src/usecase/session-isolation/index.ts';

const entryKey = {
  businessSessionDomain: 'im',
  businessSessionType: 'group',
  businessSessionId: 'group-a',
};

function createBusinessEntryKeyResolver(result) {
  const calls = [];
  const resolved = arguments.length === 0 ? entryKey : result;
  return {
    calls,
    resolver: {
      resolve: (input) => {
        calls.push(input);
        return resolved;
      },
    },
  };
}

function createResolveEntrySessionContextUseCase(result) {
  const calls = [];
  return {
    calls,
    useCase: {
      execute: async (input) => {
        calls.push(input);
        return result;
      },
    },
  };
}

function createHostSessionGateway() {
  const calls = [];
  return {
    calls,
    gateway: {
      get: async () => ({ id: 'unused' }),
      list: async () => [],
      create: async () => ({ id: 'unused' }),
      delete: async () => ({ applied: true }),
      prompt: async (input) => {
        calls.push({ method: 'prompt', input });
        return { applied: true };
      },
    },
  };
}

function createSwitchAttachedSessionUseCase() {
  const calls = [];
  return {
    calls,
    useCase: {
      execute: async (input) => {
        calls.push(input);
        return { applied: true };
      },
    },
  };
}

function createCreateOwnedSessionUseCase(session = { id: 'ses-created' }) {
  const calls = [];
  return {
    calls,
    useCase: {
      execute: async (input) => {
        calls.push(input);
        return { session };
      },
    },
  };
}

describe('DefaultChatCommandUseCase', () => {
  test('prompts the currently resolved attached session', async () => {
    const keyResolver = createBusinessEntryKeyResolver();
    const context = createResolveEntrySessionContextUseCase({
      toolSessionId: 'tool-1',
      session: { id: 'ses-bound', directory: '/repo' },
      visibleSessions: [{ id: 'ses-bound', directory: '/repo' }],
    });
    const host = createHostSessionGateway();
    const switchUseCase = createSwitchAttachedSessionUseCase();
    const createUseCase = createCreateOwnedSessionUseCase();
    const useCase = new DefaultChatCommandUseCase({
      businessEntryKeyResolver: keyResolver.resolver,
      resolveEntrySessionContextUseCase: context.useCase,
      switchAttachedSessionUseCase: switchUseCase.useCase,
      createOwnedSessionUseCase: createUseCase.useCase,
      hostSessionGateway: host.gateway,
    });

    assert.deepStrictEqual(await useCase.execute({
      toolSessionId: 'tool-1',
      text: 'hello',
      assistantId: 'assistant-1',
      extParameters: { platformExtParam: {} },
    }), {
      kind: 'prompted',
      toolSessionId: 'tool-1',
      sessionId: 'ses-bound',
    });
    assert.deepStrictEqual(context.calls, [{
      toolSessionId: 'tool-1',
      entryKey,
    }]);
    assert.deepStrictEqual(host.calls, [{
      method: 'prompt',
      input: {
        sessionId: 'ses-bound',
        text: 'hello',
        assistantId: 'assistant-1',
      },
    }]);
    assert.deepStrictEqual(switchUseCase.calls, []);
    assert.deepStrictEqual(createUseCase.calls, []);
  });

  test('switches to the first visible session when anchor is not attached', async () => {
    const keyResolver = createBusinessEntryKeyResolver();
    const context = createResolveEntrySessionContextUseCase({
      toolSessionId: 'tool-1',
      visibleSessions: [{ id: 'ses-visible', directory: '/repo' }],
    });
    const host = createHostSessionGateway();
    const switchUseCase = createSwitchAttachedSessionUseCase();
    const createUseCase = createCreateOwnedSessionUseCase();
    const useCase = new DefaultChatCommandUseCase({
      businessEntryKeyResolver: keyResolver.resolver,
      resolveEntrySessionContextUseCase: context.useCase,
      switchAttachedSessionUseCase: switchUseCase.useCase,
      createOwnedSessionUseCase: createUseCase.useCase,
      hostSessionGateway: host.gateway,
    });

    assert.deepStrictEqual(await useCase.execute({
      toolSessionId: 'tool-1',
      text: 'hello',
      extParameters: {},
    }), {
      kind: 'prompted',
      toolSessionId: 'tool-1',
      sessionId: 'ses-visible',
    });
    assert.deepStrictEqual(switchUseCase.calls, [{
      toolSessionId: 'tool-1',
      sessionId: 'ses-visible',
    }]);
    assert.deepStrictEqual(host.calls, [{
      method: 'prompt',
      input: { sessionId: 'ses-visible', text: 'hello' },
    }]);
    assert.deepStrictEqual(createUseCase.calls, []);
  });

  test('creates an owned session when no visible session exists', async () => {
    const keyResolver = createBusinessEntryKeyResolver();
    const context = createResolveEntrySessionContextUseCase({
      toolSessionId: 'tool-1',
      visibleSessions: [],
    });
    const host = createHostSessionGateway();
    const switchUseCase = createSwitchAttachedSessionUseCase();
    const createUseCase = createCreateOwnedSessionUseCase({ id: 'ses-created', directory: '/repo' });
    const useCase = new DefaultChatCommandUseCase({
      businessEntryKeyResolver: keyResolver.resolver,
      resolveEntrySessionContextUseCase: context.useCase,
      switchAttachedSessionUseCase: switchUseCase.useCase,
      createOwnedSessionUseCase: createUseCase.useCase,
      hostSessionGateway: host.gateway,
    });

    assert.deepStrictEqual(await useCase.execute({
      toolSessionId: 'tool-1',
      text: 'hello',
      assistantId: 'assistant-1',
      extParameters: {},
    }), {
      kind: 'prompted',
      toolSessionId: 'tool-1',
      sessionId: 'ses-created',
    });
    assert.deepStrictEqual(createUseCase.calls, [{
      toolSessionId: 'tool-1',
      entryKey,
      assistantId: 'assistant-1',
    }]);
    assert.deepStrictEqual(host.calls, [{
      method: 'prompt',
      input: {
        sessionId: 'ses-created',
        text: 'hello',
        assistantId: 'assistant-1',
      },
    }]);
    assert.deepStrictEqual(switchUseCase.calls, []);
  });

  test('fails closed when entry key cannot be resolved', async () => {
    const keyResolver = createBusinessEntryKeyResolver(undefined);
    const context = createResolveEntrySessionContextUseCase({
      toolSessionId: 'tool-1',
      visibleSessions: [],
    });
    const host = createHostSessionGateway();
    const switchUseCase = createSwitchAttachedSessionUseCase();
    const createUseCase = createCreateOwnedSessionUseCase();
    const useCase = new DefaultChatCommandUseCase({
      businessEntryKeyResolver: keyResolver.resolver,
      resolveEntrySessionContextUseCase: context.useCase,
      switchAttachedSessionUseCase: switchUseCase.useCase,
      createOwnedSessionUseCase: createUseCase.useCase,
      hostSessionGateway: host.gateway,
    });

    await assert.rejects(
      () => useCase.execute({ toolSessionId: 'tool-1', text: 'hello', extParameters: {} }),
      /business entry key required/u,
    );
    assert.deepStrictEqual(context.calls, []);
    assert.deepStrictEqual(host.calls, []);
  });
});
