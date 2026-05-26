import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionIsolationSlashCommandExecutor } from '../../src/runtime/sdk/session-isolation/index.ts';

const entryContext = {
  entryKey: {
    businessSessionDomain: 'im',
    businessSessionType: 'direct',
    businessSessionId: 'user-a',
  },
  policy: {
    entryKey: 'im:direct:user-a',
    controlled: true,
    allowOpencodeNativeSessions: false,
    allowedSlashCommands: ['new', 'sessions', 'session', 'models', 'model'],
  },
};

function createRuntimeAnchorRepository(calls) {
  const anchorOnly = new Set(['tool-anchor-only']);
  return {
    isAnchorOnly: async (toolSessionId) => anchorOnly.has(toolSessionId),
    setAnchorOnly: async (toolSessionId) => {
      anchorOnly.add(toolSessionId);
    },
    delete: async (toolSessionId) => {
      calls.push({ method: 'deleteAnchorOnly', toolSessionId });
      anchorOnly.delete(toolSessionId);
    },
  };
}

function createExecutor(overrides = {}) {
  const calls = [];
  const executor = new SessionIsolationSlashCommandExecutor({
    resolveEntrySessionContextUseCase: {
      execute: async (input) => {
        calls.push({ method: 'resolve', input });
        return overrides.context ?? {
          toolSessionId: input.toolSessionId,
          session: { id: 'ses-current', title: '当前会话', directory: '/repo' },
          visibleSessions: [
            { id: 'ses-current', title: '当前会话', directory: '/repo' },
            { id: 'ses-target', title: '目标会话', directory: '/repo' },
          ],
        };
      },
    },
    switchAttachedSessionUseCase: {
      execute: async (input) => {
        calls.push({ method: 'switch', input });
        return { applied: true };
      },
    },
    createOwnedSessionUseCase: {
      execute: async (input) => {
        calls.push({ method: 'createOwned', input });
        return { session: { id: 'ses-created', title: '新会话', directory: input.directory } };
      },
    },
    runtimeAnchorRepository: createRuntimeAnchorRepository(calls),
  });
  return { executor, calls };
}

test('SessionIsolationSlashCommandExecutor lists visible sessions from entry context only', async () => {
  const { executor, calls } = createExecutor();

  const result = await executor.execute({
    command: { kind: 'sessions' },
    anchor: 'tool-a',
    entryContext,
    directory: '/repo',
  });

  assert.deepEqual(result, {
    kind: 'sessions',
    activeSessionId: 'ses-current',
    sessions: [
      { id: 'ses-current', title: '当前会话', directory: '/repo' },
      { id: 'ses-target', title: '目标会话', directory: '/repo' },
    ],
  });
  assert.deepEqual(calls, [{
    method: 'resolve',
    input: {
      toolSessionId: 'tool-a',
      entryKey: entryContext.entryKey,
      policy: entryContext.policy,
      directory: '/repo',
    },
  }]);
});

test('SessionIsolationSlashCommandExecutor switches only to a visible session and clears anchor-only state', async () => {
  const { executor, calls } = createExecutor();

  const result = await executor.execute({
    command: { kind: 'session', sessionId: 'ses-target' },
    anchor: 'tool-anchor-only',
    entryContext,
    directory: '/repo',
  });

  assert.deepEqual(result, {
    kind: 'session',
    previousSessionId: 'ses-current',
    session: { id: 'ses-target', title: '目标会话', directory: '/repo' },
  });
  assert.deepEqual(calls.map((call) => call.method), ['resolve', 'switch', 'deleteAnchorOnly']);
  assert.deepEqual(calls[1], {
    method: 'switch',
    input: { toolSessionId: 'tool-anchor-only', sessionId: 'ses-target' },
  });
});

test('SessionIsolationSlashCommandExecutor rejects invisible target sessions without switching', async () => {
  const { executor, calls } = createExecutor();

  await assert.rejects(
    async () => executor.execute({
      command: { kind: 'session', sessionId: 'ses-out' },
      anchor: 'tool-a',
      entryContext,
      directory: '/repo',
    }),
    { code: 'session_out_of_scope' },
  );
  assert.deepEqual(calls.map((call) => call.method), ['resolve']);
});

test('SessionIsolationSlashCommandExecutor creates owned session for /new through session-isolation use case', async () => {
  const { executor, calls } = createExecutor();

  const result = await executor.execute({
    command: { kind: 'new' },
    anchor: 'tool-anchor-only',
    entryContext,
    createContext: { assistantId: 'assistant-a', imGroupId: 'group-ignored' },
    directory: '/repo',
  });

  assert.deepEqual(result, {
    kind: 'new',
    session: { id: 'ses-created', title: '新会话', directory: '/repo' },
  });
  assert.deepEqual(calls.map((call) => call.method), ['createOwned', 'deleteAnchorOnly']);
  assert.deepEqual(calls[0], {
    method: 'createOwned',
    input: {
      toolSessionId: 'tool-anchor-only',
      entryKey: entryContext.entryKey,
      policy: entryContext.policy,
      assistantId: 'assistant-a',
      directory: '/repo',
    },
  });
});
