import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultResolveEntrySessionContextUseCase } from '../../src/usecase/session-isolation/index.ts';
import { DefaultEntryKeyCodec } from '../../src/domain/session-isolation/index.ts';

class MemoryOwnedSessionRepository {
  records = [];

  async findByEntryKey(input) {
    return this.records.filter(
      (record) => record.akScopeKey === input.akScopeKey && record.entryKey === input.entryKey,
    );
  }

  async findBySessionId(input) {
    return this.records.find(
      (record) => record.akScopeKey === input.akScopeKey && record.sessionId === input.sessionId,
    );
  }

  async upsert(record) {
    this.records.push(record);
  }

  async deleteBySessionId(input) {
    this.records = this.records.filter(
      (record) => !(record.akScopeKey === input.akScopeKey && record.sessionId === input.sessionId),
    );
  }
}

class MemoryAnchorBindingRepository {
  records = new Map();

  async get(toolSessionId) {
    return this.records.get(toolSessionId);
  }

  async findBySessionId(sessionId) {
    return [...this.records.values()].filter((record) => record.sessionId === sessionId);
  }

  async upsert(record) {
    this.records.set(record.toolSessionId, record);
  }

  async delete(toolSessionId) {
    this.records.delete(toolSessionId);
  }
}

function createHostSessionGateway(sessions) {
  const calls = [];
  return {
    calls,
    gateway: {
      get: async (sessionId) => {
        calls.push({ method: 'get', sessionId });
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session) {throw new Error(`session not found: ${sessionId}`);}
        return session;
      },
      list: async (input) => {
        calls.push({ method: 'list', input });
        return sessions.filter((session) => !input.directory || session.directory === input.directory);
      },
      create: async () => {
        throw new Error('create must not be called by resolver');
      },
      delete: async () => ({ applied: true }),
      prompt: async () => ({ applied: true }),
    },
  };
}

function createLogger(entries) {
  const info = (message, extra) => entries.push({ level: 'info', message, extra });
  return {
    debug: () => undefined,
    info,
    warn: () => undefined,
    error: () => undefined,
    child: () => createLogger(entries),
    getTraceId: () => 'trace-test',
  };
}

const entryKey = {
  businessSessionDomain: 'IM',
  businessSessionType: 'Group',
  businessSessionId: 'GroupA',
};

function createUseCase({ sessions = [], ownedRecords = [], binding } = {}) {
  const logEntries = [];
  const ownedSessionRepository = new MemoryOwnedSessionRepository();
  ownedSessionRepository.records = ownedRecords;
  const anchorBindingRepository = new MemoryAnchorBindingRepository();
  if (binding) {
    anchorBindingRepository.records.set(binding.toolSessionId, binding);
  }
  const host = createHostSessionGateway(sessions);
  return {
    host,
    useCase: new DefaultResolveEntrySessionContextUseCase({
      akScopeKey: 'ak-test',
      entryKeyCodec: new DefaultEntryKeyCodec(),
      ownedSessionRepository,
      anchorBindingRepository,
      hostSessionGateway: host.gateway,
      logger: createLogger(logEntries),
    }),
    logEntries,
  };
}

describe('DefaultResolveEntrySessionContextUseCase', () => {
  test('returns active attached session when anchor binding points to a visible owned session', async () => {
    const { useCase, host, logEntries } = createUseCase({
      sessions: [{ id: 'ses-1', directory: '/repo' }, { id: 'ses-2', directory: '/repo' }],
      ownedRecords: [
        {
          akScopeKey: 'ak-test',
          entryKey: 'im:group:GroupA',
          sessionId: 'ses-1',
          controlled: true,
          permissionProfile: 'default',
        },
      ],
      binding: { toolSessionId: 'tool-1', sessionId: 'ses-1', state: 'attached' },
    });

    assert.deepStrictEqual(await useCase.execute({
      toolSessionId: 'tool-1',
      entryKey,
      policy: {
        entryKey: 'im:group:GroupA',
        controlled: true,
        allowOpencodeNativeSessions: false,
        allowedSlashCommands: ['new', 'models', 'model'],
      },
      directory: '/repo',
      roots: true,
      start: 1_777_766_400_000,
    }), {
      toolSessionId: 'tool-1',
      bindingSessionId: 'ses-1',
      session: { id: 'ses-1', directory: '/repo' },
      visibleSessions: [{ id: 'ses-1', directory: '/repo' }],
    });
    assert.deepStrictEqual(host.calls, [{
      method: 'list',
      input: { directory: '/repo', roots: true, start: 1_777_766_400_000 },
    }]);
    assert.deepStrictEqual(logEntries[0], {
      level: 'info',
      message: 'session_isolation.context.resolved',
      extra: {
        toolSessionId: 'tool-1',
        entryKey: 'im:group:GroupA',
        allowOpencodeNativeSessions: false,
        bindingSessionId: 'ses-1',
        hostVisibleSessionIds: ['ses-1', 'ses-2'],
        ownedSessionIds: ['ses-1'],
        visibleSessionIds: ['ses-1'],
        resolvedSessionId: 'ses-1',
        directory: '/repo',
        roots: true,
        start: 1_777_766_400_000,
        hasBinding: true,
      },
    });
  });

  test('omits session when anchor binding is missing or points outside entry visibility', async () => {
    const { useCase } = createUseCase({
      sessions: [{ id: 'ses-owned', directory: '/repo' }, { id: 'ses-other', directory: '/repo' }],
      ownedRecords: [
        {
          akScopeKey: 'ak-test',
          entryKey: 'im:group:GroupA',
          sessionId: 'ses-owned',
          controlled: true,
          permissionProfile: 'default',
        },
      ],
      binding: { toolSessionId: 'tool-1', sessionId: 'ses-other', state: 'attached' },
    });

    assert.deepStrictEqual(await useCase.execute({
      toolSessionId: 'tool-1',
      entryKey,
      policy: {
        entryKey: 'im:group:GroupA',
        controlled: true,
        allowOpencodeNativeSessions: false,
        allowedSlashCommands: ['new', 'models', 'model'],
      },
      directory: '/repo',
    }), {
      toolSessionId: 'tool-1',
      bindingSessionId: 'ses-other',
      visibleSessions: [{ id: 'ses-owned', directory: '/repo' }],
    });
  });

  test('does not expose owned sessions that are absent from host visible list', async () => {
    const { useCase } = createUseCase({
      sessions: [{ id: 'ses-visible', directory: '/repo' }],
      ownedRecords: [
        {
          akScopeKey: 'ak-test',
          entryKey: 'im:group:GroupA',
          sessionId: 'ses-stale',
          controlled: true,
          permissionProfile: 'default',
        },
      ],
      binding: { toolSessionId: 'tool-1', sessionId: 'ses-stale', state: 'attached' },
    });

    assert.deepStrictEqual(await useCase.execute({
      toolSessionId: 'tool-1',
      entryKey,
      policy: {
        entryKey: 'im:group:GroupA',
        controlled: true,
        allowOpencodeNativeSessions: false,
        allowedSlashCommands: ['new', 'models', 'model'],
      },
      directory: '/repo',
    }), {
      toolSessionId: 'tool-1',
      bindingSessionId: 'ses-stale',
      visibleSessions: [],
    });
  });

  test('includes native sessions when policy allows native exposure while preserving host order', async () => {
    const { useCase } = createUseCase({
      sessions: [
        { id: 'ses-native-first', directory: '/repo' },
        { id: 'ses-owned-current', directory: '/repo' },
        { id: 'ses-native-last', directory: '/repo' },
      ],
      ownedRecords: [
        {
          akScopeKey: 'ak-test',
          entryKey: 'im:direct:user-a#bot-a',
          sessionId: 'ses-owned-current',
          controlled: false,
          permissionProfile: 'default',
        },
      ],
    });

    assert.deepStrictEqual(await useCase.execute({
      toolSessionId: 'tool-direct',
      entryKey: {
        businessSessionDomain: 'im',
        businessSessionType: 'direct',
        businessSessionId: 'user-a#bot-a',
      },
      policy: {
        entryKey: 'im:direct:user-a#bot-a',
        controlled: false,
        allowOpencodeNativeSessions: true,
        allowedSlashCommands: ['new', 'sessions', 'session', 'models', 'model'],
      },
      directory: '/repo',
    }), {
      toolSessionId: 'tool-direct',
      visibleSessions: [
        { id: 'ses-native-first', directory: '/repo' },
        { id: 'ses-owned-current', directory: '/repo' },
        { id: 'ses-native-last', directory: '/repo' },
      ],
    });
  });

  test('does not expose other entry owned sessions as native sessions', async () => {
    const { useCase } = createUseCase({
      sessions: [
        { id: 'ses-other-owned', directory: '/repo' },
        { id: 'ses-native', directory: '/repo' },
      ],
      ownedRecords: [
        {
          akScopeKey: 'ak-test',
          entryKey: 'im:group:OtherGroup',
          sessionId: 'ses-other-owned',
          controlled: true,
          permissionProfile: 'dialog_only',
        },
      ],
    });

    assert.deepStrictEqual(await useCase.execute({
      toolSessionId: 'tool-direct',
      entryKey: {
        businessSessionDomain: 'im',
        businessSessionType: 'direct',
        businessSessionId: 'user-a#bot-a',
      },
      policy: {
        entryKey: 'im:direct:user-a#bot-a',
        controlled: false,
        allowOpencodeNativeSessions: true,
        allowedSlashCommands: ['new', 'sessions', 'session', 'models', 'model'],
      },
      directory: '/repo',
    }), {
      toolSessionId: 'tool-direct',
      visibleSessions: [{ id: 'ses-native', directory: '/repo' }],
    });
  });
});
