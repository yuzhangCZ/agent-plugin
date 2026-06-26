import test from 'node:test';
import assert from 'node:assert/strict';

import { InMemorySessionModelOverrideStore } from '../../src/adapter/index.ts';
import { SdkChatSlashCommandExecutor } from '../../src/runtime/sdk/SdkChatSlashCommandExecutor.ts';
import { TUI_SESSION_LIST_WINDOW_MS } from '../../src/runtime/sdk/session-isolation/index.ts';

const FIXED_NOW = Date.parse('2026-06-03T00:00:00.000Z');

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

const ensuredContext = {
  opencodeSessionId: 'ses-current',
  session: { id: 'ses-current', title: '当前会话', directory: '/repo' },
  bootstrapSource: 'existing_binding',
};

function createActionContext(overrides = {}) {
  const message = overrides.message ?? {
    traceId: 'trace-action',
    runId: 'run-action',
    toolSessionId: overrides.anchor ?? 'tool-a',
    text: 'hello',
  };
  const {
    opencodeSessionId,
    session,
    scope,
    modelOverride,
    bootstrapSource,
    directory,
    sessionContext,
    effectiveDirectory,
    ...rest
  } = overrides;
  return {
    message,
    anchor: message.toolSessionId,
    entryContext,
    sessionContext: {
      opencodeSessionId: opencodeSessionId ?? sessionContext?.opencodeSessionId ?? ensuredContext.opencodeSessionId,
      session: session ?? sessionContext?.session ?? ensuredContext.session,
      ...(scope ?? sessionContext?.scope ? { scope: scope ?? sessionContext.scope } : {}),
      ...(modelOverride ?? sessionContext?.modelOverride ? { modelOverride: modelOverride ?? sessionContext.modelOverride } : {}),
      bootstrapSource: bootstrapSource ?? sessionContext?.bootstrapSource ?? ensuredContext.bootstrapSource,
    },
    effectiveDirectory: directory ?? effectiveDirectory ?? '/repo',
    ...rest,
  };
}

function createRuntimeAnchorRepository(calls) {
  const anchorOnly = new Set(['tool-anchor-only']);
  return {
    isAnchorOnly: async (toolSessionId) => anchorOnly.has(toolSessionId),
    createAnchorOnly: async (toolSessionId) => {
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
  const modelOverrideStore = overrides.modelOverrideStore ?? new InMemorySessionModelOverrideStore();
  const executor = new SdkChatSlashCommandExecutor({
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
    modelOverrideStore,
    hostModelCatalogPort: overrides.hostModelCatalogPort ?? {
      listModels: async () => [
        { providerId: 'openai', modelId: 'gpt-5.4' },
        { providerId: 'anthropic', modelId: 'claude' },
      ],
    },
    ...(overrides.logger ? { logger: overrides.logger } : {}),
  });
  return { executor, calls, modelOverrideStore };
}

test('SdkChatSlashCommandExecutor lists entry-visible sessions with TUI query', async () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  const logs = [];
  const { executor, calls } = createExecutor({
    logger: {
      info: (message, extra) => logs.push({ level: 'info', message, extra }),
    },
  });

  try {
    const result = await executor.execute({
      command: { kind: 'sessions' },
      context: createActionContext({ anchor: 'tool-a' }),
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
        roots: true,
        start: FIXED_NOW - TUI_SESSION_LIST_WINDOW_MS,
      },
    }]);
    assert.deepEqual(logs, [{
      level: 'info',
      message: 'session_isolation.slash.sessions.resolved',
      extra: {
        anchor: 'tool-a',
        activeSessionId: 'ses-current',
        visibleSessionIds: ['ses-current', 'ses-target'],
        visibleSessionCount: 2,
        directory: '/repo',
      },
    }]);
  } finally {
    Date.now = originalNow;
  }
});

test('SdkChatSlashCommandExecutor switches only to visible sessions and clears anchor-only state', async () => {
  const { executor, calls } = createExecutor();

  const result = await executor.execute({
      command: { kind: 'session', sessionId: 'ses-target' },
      context: createActionContext({ anchor: 'tool-anchor-only' }),
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

test('SdkChatSlashCommandExecutor rejects invisible target sessions', async () => {
  const { executor, calls } = createExecutor({
    context: {
      toolSessionId: 'tool-a',
      session: { id: 'ses-current', title: '当前会话', directory: '/repo' },
      visibleSessions: [{ id: 'ses-current', title: '当前会话', directory: '/repo' }],
    },
  });

  await assert.rejects(
    () => executor.execute({
      command: { kind: 'session', sessionId: 'ses-missing' },
      context: createActionContext({ anchor: 'tool-a' }),
    }),
    { code: 'session_out_of_scope' },
  );
  assert.deepEqual(calls.map((call) => call.method), ['resolve']);
});

test('SdkChatSlashCommandExecutor creates owned sessions and clears anchor-only state', async () => {
  const logs = [];
  const { executor, calls } = createExecutor({
    logger: {
      info: (message, extra) => logs.push({ level: 'info', message, extra }),
    },
  });

  const result = await executor.execute({
    command: { kind: 'new' },
    context: createActionContext({
      message: {
        traceId: 'trace-new',
        runId: 'run-new',
        toolSessionId: 'tool-anchor-only',
        text: '/new',
        assistantId: 'assistant-persona',
      },
      ...ensuredContext,
      opencodeSessionId: 'ses-before-new',
      directory: '/repo/new',
    }),
  });

  assert.deepEqual(result, {
    kind: 'new',
    previousSessionId: 'ses-before-new',
    session: { id: 'ses-created', title: '新会话', directory: '/repo/new' },
  });
  assert.deepEqual(calls, [
    {
      method: 'createOwned',
      input: {
        toolSessionId: 'tool-anchor-only',
        entryKey: entryContext.entryKey,
        policy: entryContext.policy,
        assistantId: 'assistant-persona',
        directory: '/repo/new',
      },
    },
    { method: 'deleteAnchorOnly', toolSessionId: 'tool-anchor-only' },
  ]);
  assert.deepEqual(logs, [{
    level: 'info',
    message: 'session_isolation.slash.new.created',
    extra: {
      anchor: 'tool-anchor-only',
      entryKey: entryContext.policy.entryKey,
      createdSessionId: 'ses-created',
      directory: '/repo/new',
    },
  }]);
});

test('SdkChatSlashCommandExecutor handles model catalog and session-scoped override', async () => {
  const { executor, modelOverrideStore } = createExecutor();

  assert.deepEqual(await executor.execute({
    command: { kind: 'models' },
    context: createActionContext({ anchor: 'tool-model' }),
  }), {
    kind: 'models',
    models: [
      { providerId: 'openai', modelId: 'gpt-5.4' },
      { providerId: 'anthropic', modelId: 'claude' },
    ],
  });

  assert.deepEqual(await executor.execute({
    command: { kind: 'model', providerId: 'openai', modelId: 'gpt-5.4' },
    context: createActionContext({ anchor: 'tool-model' }),
  }), {
    kind: 'model',
    sessionId: 'ses-current',
    modelOverride: { providerId: 'openai', modelId: 'gpt-5.4' },
  });
  assert.deepEqual(modelOverrideStore.get('ses-current'), {
    providerId: 'openai',
    modelId: 'gpt-5.4',
  });
});

test('SdkChatSlashCommandExecutor rejects missing model catalog entries', async () => {
  const { executor, modelOverrideStore } = createExecutor();

  await assert.rejects(
    () => executor.execute({
      command: { kind: 'model', providerId: 'openai', modelId: 'missing' },
      context: createActionContext({ anchor: 'tool-model' }),
    }),
    { code: 'model_not_found' },
  );
  assert.equal(modelOverrideStore.get('ses-current'), undefined);
});
