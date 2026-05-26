import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DefaultCloseOwnedSessionUseCase,
  DefaultCreateOwnedSessionUseCase,
  DefaultCreateSessionCommandUseCase,
} from '../../src/usecase/session-isolation/index.ts';

function createHostSessionGateway() {
  const calls = [];
  return {
    calls,
    gateway: {
      get: async () => ({ id: 'ses-created' }),
      list: async () => [],
      create: async (input) => {
        calls.push({ method: 'create', input });
        return { id: 'ses-created', title: input.title, directory: input.directory };
      },
      delete: async (sessionId) => {
        calls.push({ method: 'delete', sessionId });
        return { applied: true };
      },
      prompt: async () => ({ applied: true }),
    },
  };
}

function createOwnedSessionCoordinator() {
  const calls = [];
  return {
    calls,
    coordinator: {
      bindOwnedSession: async (input) => {
        calls.push({ method: 'bindOwnedSession', input });
        return { applied: true };
      },
      switchAttachedSession: async (input) => {
        calls.push({ method: 'switchAttachedSession', input });
        return { applied: true };
      },
      closeOwnedSession: async (input) => {
        calls.push({ method: 'closeOwnedSession', input });
        return { applied: true };
      },
      reconcileDeletedSession: async (input) => {
        calls.push({ method: 'reconcileDeletedSession', input });
        return { applied: true };
      },
    },
  };
}

function createAnchorBindingRepository(record) {
  const calls = [];
  return {
    calls,
    repository: {
      get: async (toolSessionId) => {
        calls.push({ method: 'get', toolSessionId });
        return record;
      },
      findBySessionId: async () => [],
      upsert: async () => {},
      delete: async () => {},
    },
  };
}

const entryKey = {
  businessSessionDomain: 'im',
  businessSessionType: 'group',
  businessSessionId: 'group-a',
};

describe('session-isolation create and close use cases', () => {
  test('CreateSessionCommandUseCase creates entry-owned session using created session id as anchor', async () => {
    const calls = [];
    const useCase = new DefaultCreateSessionCommandUseCase({
      businessEntryKeyResolver: {
        resolve: (input) => {
          calls.push({ method: 'resolve', input });
          return entryKey;
        },
      },
      hostSessionGateway: {
        create: async (input) => {
          calls.push({ method: 'create', input });
          return { id: 'ses-created', title: input.title };
        },
      },
      ownedSessionCoordinator: {
        bindOwnedSession: async (input) => {
          calls.push({ method: 'bindOwnedSession', input });
          return { applied: true };
        },
      },
    });

    assert.deepStrictEqual(await useCase.execute({
      welinkSessionId: 'welink-1',
      title: 'New session',
      assistantId: 'assistant-1',
      extParameters: { platformExtParam: { businessSessionId: 'group-a' } },
    }), {
      kind: 'entry_owned',
      toolSessionId: 'ses-created',
      session: { id: 'ses-created', title: 'New session' },
    });
    assert.deepStrictEqual(calls, [
      {
        method: 'resolve',
        input: {
          source: 'create_session',
          welinkSessionId: 'welink-1',
          extParameters: { platformExtParam: { businessSessionId: 'group-a' } },
        },
      },
      {
        method: 'create',
        input: {
          title: 'New session',
          assistantId: 'assistant-1',
          control: {
            controlled: true,
            permissionProfile: 'dialog_only',
          },
        },
      },
      {
        method: 'bindOwnedSession',
        input: {
          toolSessionId: 'ses-created',
          sessionId: 'ses-created',
          entryKey,
          title: 'New session',
          assistantId: 'assistant-1',
        },
      },
    ]);
  });

  test('CreateSessionCommandUseCase deletes created host session when ownership binding fails', async () => {
    const calls = [];
    const useCase = new DefaultCreateSessionCommandUseCase({
      businessEntryKeyResolver: {
        resolve: () => entryKey,
      },
      hostSessionGateway: {
        create: async (input) => {
          calls.push({ method: 'create', input });
          return { id: 'ses-orphan-candidate' };
        },
        delete: async (sessionId) => {
          calls.push({ method: 'delete', sessionId });
          return { applied: true };
        },
      },
      ownedSessionCoordinator: {
        bindOwnedSession: async (input) => {
          calls.push({ method: 'bindOwnedSession', input });
          throw new Error('bind_failed');
        },
      },
    });

    await assert.rejects(
      () => useCase.execute({ welinkSessionId: 'welink-cleanup' }),
      /bind_failed/,
    );
    assert.deepStrictEqual(calls.map((call) => call.method), [
      'create',
      'bindOwnedSession',
      'delete',
    ]);
    assert.deepStrictEqual(calls[2], { method: 'delete', sessionId: 'ses-orphan-candidate' });
  });

  test('CreateSessionCommandUseCase creates anchor-only runtime anchor without host session when business entry is absent', async () => {
    const calls = [];
    const useCase = new DefaultCreateSessionCommandUseCase({
      toolSessionIdFactory: () => 'tool-anchor-only',
      businessEntryKeyResolver: {
        resolve: (input) => {
          calls.push({ method: 'resolve', input });
          return undefined;
        },
      },
      hostSessionGateway: {
        create: async (input) => {
          calls.push({ method: 'create', input });
          return { id: 'ses-anchor-only' };
        },
      },
      ownedSessionCoordinator: {
        bindOwnedSession: async (input) => {
          calls.push({ method: 'bindOwnedSession', input });
          return { applied: true };
        },
      },
      runtimeAnchorRepository: {
        createAnchorOnly: async (input) => {
          calls.push({ method: 'createAnchorOnly', input });
        },
      },
    });

    assert.deepStrictEqual(await useCase.execute({
      welinkSessionId: 'welink-without-entry',
    }), {
      kind: 'anchor_only',
      toolSessionId: 'tool-anchor-only',
    });
    assert.deepStrictEqual(calls, [
      {
        method: 'resolve',
        input: {
          source: 'create_session',
          welinkSessionId: 'welink-without-entry',
          extParameters: undefined,
        },
      },
      {
        method: 'createAnchorOnly',
        input: { toolSessionId: 'tool-anchor-only' },
      },
    ]);
  });

  test('CreateOwnedSessionUseCase creates controlled host session then binds ownership through coordinator', async () => {
    const host = createHostSessionGateway();
    const owned = createOwnedSessionCoordinator();
    const useCase = new DefaultCreateOwnedSessionUseCase({
      hostSessionGateway: host.gateway,
      ownedSessionCoordinator: owned.coordinator,
    });

    assert.deepStrictEqual(await useCase.execute({
      toolSessionId: 'tool-1',
      entryKey,
      title: 'Group A',
      assistantId: 'assistant-1',
      directory: '/repo',
    }), {
      session: { id: 'ses-created', title: 'Group A', directory: '/repo' },
    });
    assert.deepStrictEqual(host.calls, [{
      method: 'create',
      input: {
        title: 'Group A',
        assistantId: 'assistant-1',
        directory: '/repo',
        control: {
          controlled: true,
          permissionProfile: 'dialog_only',
        },
      },
    }]);
    assert.deepStrictEqual(owned.calls, [{
      method: 'bindOwnedSession',
      input: {
        toolSessionId: 'tool-1',
        sessionId: 'ses-created',
        entryKey,
        title: 'Group A',
        assistantId: 'assistant-1',
        directory: '/repo',
      },
    }]);
  });

  test('CreateOwnedSessionUseCase deletes created host session when ownership binding fails', async () => {
    const host = createHostSessionGateway();
    const useCase = new DefaultCreateOwnedSessionUseCase({
      hostSessionGateway: host.gateway,
      ownedSessionCoordinator: {
        bindOwnedSession: async () => {
          throw new Error('bind_failed');
        },
      },
    });

    await assert.rejects(
      () => useCase.execute({
        toolSessionId: 'tool-cleanup',
        entryKey,
      }),
      /bind_failed/,
    );
    assert.deepStrictEqual(host.calls.map((call) => call.method), ['create', 'delete']);
    assert.deepStrictEqual(host.calls[1], { method: 'delete', sessionId: 'ses-created' });
  });

  test('CloseOwnedSessionUseCase deletes bound host session before coordinator cleanup', async () => {
    const host = createHostSessionGateway();
    const owned = createOwnedSessionCoordinator();
    const anchor = createAnchorBindingRepository({
      toolSessionId: 'tool-close',
      sessionId: 'ses-close',
      state: 'attached',
    });
    const useCase = new DefaultCloseOwnedSessionUseCase({
      anchorBindingRepository: anchor.repository,
      hostSessionGateway: host.gateway,
      ownedSessionCoordinator: owned.coordinator,
    });

    assert.deepStrictEqual(await useCase.execute({ toolSessionId: 'tool-close' }), {
      kind: 'closed',
      sessionId: 'ses-close',
    });
    assert.deepStrictEqual(anchor.calls, [{ method: 'get', toolSessionId: 'tool-close' }]);
    assert.deepStrictEqual(host.calls, [{ method: 'delete', sessionId: 'ses-close' }]);
    assert.deepStrictEqual(owned.calls, [{
      method: 'closeOwnedSession',
      input: { toolSessionId: 'tool-close' },
    }]);
  });

  test('CloseOwnedSessionUseCase returns not_bound and still asks coordinator to clear stale anchor state', async () => {
    const host = createHostSessionGateway();
    const owned = createOwnedSessionCoordinator();
    const anchor = createAnchorBindingRepository(undefined);
    const useCase = new DefaultCloseOwnedSessionUseCase({
      anchorBindingRepository: anchor.repository,
      hostSessionGateway: host.gateway,
      ownedSessionCoordinator: owned.coordinator,
    });

    assert.deepStrictEqual(await useCase.execute({ toolSessionId: 'tool-missing' }), {
      kind: 'not_bound',
    });
    assert.deepStrictEqual(host.calls, []);
    assert.deepStrictEqual(owned.calls, [{
      method: 'closeOwnedSession',
      input: { toolSessionId: 'tool-missing' },
    }]);
  });

  test('CloseOwnedSessionUseCase deletes anchor-only runtime anchor without host delete', async () => {
    const host = createHostSessionGateway();
    const owned = createOwnedSessionCoordinator();
    const anchor = createAnchorBindingRepository(undefined);
    const calls = [];
    const useCase = new DefaultCloseOwnedSessionUseCase({
      anchorBindingRepository: anchor.repository,
      hostSessionGateway: host.gateway,
      ownedSessionCoordinator: owned.coordinator,
      runtimeAnchorRepository: {
        isAnchorOnly: async (toolSessionId) => {
          calls.push({ method: 'isAnchorOnly', toolSessionId });
          return true;
        },
        delete: async (toolSessionId) => {
          calls.push({ method: 'deleteAnchorOnly', toolSessionId });
        },
      },
    });

    assert.deepStrictEqual(await useCase.execute({ toolSessionId: 'tool-anchor-only-close' }), {
      kind: 'not_bound',
    });
    assert.deepStrictEqual(calls, [
      { method: 'isAnchorOnly', toolSessionId: 'tool-anchor-only-close' },
      { method: 'deleteAnchorOnly', toolSessionId: 'tool-anchor-only-close' },
    ]);
    assert.deepStrictEqual(host.calls, []);
    assert.deepStrictEqual(owned.calls, []);
  });
});
