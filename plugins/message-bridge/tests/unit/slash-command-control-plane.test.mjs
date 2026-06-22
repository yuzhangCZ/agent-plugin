import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryOpencodeSessionOwnershipResolver,
  InMemorySessionModelOverrideStore,
  InMemoryToolSessionBindingStore,
  SimpleSlashCommandParser,
} from '../../src/adapter/index.ts';
import {
  DefaultSlashCommandOrchestrator,
  DefaultSlashCommandReplyPresenter,
  ResolveSlashCommandContextUseCase,
} from '../../src/usecase/index.ts';
import { TUI_SESSION_LIST_WINDOW_MS } from '../../src/runtime/sdk/session-isolation/index.ts';

const FIXED_NOW = Date.parse('2026-06-03T00:00:00.000Z');

function createLoggerRecorder() {
  const errors = [];
  const infos = [];
  return {
    errors,
    infos,
    logger: {
      debug: () => undefined,
      info: (event, fields) => {
        infos.push({ event, fields });
      },
      warn: () => undefined,
      error: (event, fields) => {
        errors.push({ event, fields });
      },
      child() {
        return this;
      },
      getTraceId: () => 'trace-test',
    },
  };
}

function createCompletionPort(result = { success: true }) {
  const calls = [];
  return {
    calls,
    port: {
      completeSuccess: async (input) => {
        calls.push({ kind: 'success', input });
        return result;
      },
      completeFailure: async (input) => {
        calls.push({ kind: 'failure', input });
        return result;
      },
    },
  };
}

function createControlPlaneDependencies(options = {}) {
  const bindingStore = options.bindingStore ?? new InMemoryToolSessionBindingStore();
  const ownershipResolver = options.ownershipResolver ?? new InMemoryOpencodeSessionOwnershipResolver();
  const modelOverrideStore = options.modelOverrideStore ?? new InMemorySessionModelOverrideStore();
  const sessions = options.sessions ?? [
    {
      id: 'ses-1',
      title: '会话一',
      projectID: 'proj-1',
      workspaceID: 'workspace-1',
      directory: '/workspace',
    },
    {
      id: 'ses-2',
      title: '会话二',
      projectID: 'proj-1',
      workspaceID: 'workspace-1',
      directory: '/workspace',
    },
  ];
  const createdSessions = [];
  const hostSessionCreationPort = options.hostSessionCreationPort ?? {
    createSession: async (input) => {
      const session = {
        id: `ses-created-${createdSessions.length + 1}`,
        title: input?.assistantId ? `assistant:${input.assistantId}` : '新会话',
        projectID: 'proj-1',
        workspaceID: 'workspace-1',
        directory: '/workspace',
      };
      createdSessions.push({ input, session });
      return session;
    },
  };
  const hostSessionQueryPort = options.hostSessionQueryPort ?? {
    getSession: async (sessionId) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) {
        throw Object.assign(new Error('session missing'), { code: 'session_not_found' });
      }
      return session;
    },
    listSessions: async (query) => sessions.filter((session) => {
      if (query.directory && session.directory !== query.directory) {
        return false;
      }
      if (query.start && session.time?.updated && session.time.updated < query.start) {
        return false;
      }
      return true;
    }),
  };
  const hostModelCatalogPort = options.hostModelCatalogPort ?? {
    listModels: async () => [
      { providerId: 'openai', modelId: 'gpt-5.4' },
      { providerId: 'anthropic', modelId: 'claude' },
    ],
  };

  return {
    bindingStore,
    ownershipResolver,
    modelOverrideStore,
    hostSessionCreationPort,
    hostSessionQueryPort,
    hostModelCatalogPort,
    createdSessions,
  };
}

function createContextResolver(deps) {
  return new ResolveSlashCommandContextUseCase({
    bindingStore: deps.bindingStore,
    ownershipResolver: deps.ownershipResolver,
    modelOverrideStore: deps.modelOverrideStore,
    hostSessionCreationPort: deps.hostSessionCreationPort,
    hostSessionQueryPort: deps.hostSessionQueryPort,
  });
}

function createOrchestrator(deps, completionPort) {
  return new DefaultSlashCommandOrchestrator({
    bindingStore: deps.bindingStore,
    ownershipResolver: deps.ownershipResolver,
    modelOverrideStore: deps.modelOverrideStore,
    hostSessionCreationPort: deps.hostSessionCreationPort,
    hostSessionQueryPort: deps.hostSessionQueryPort,
    hostModelCatalogPort: deps.hostModelCatalogPort,
    replyPresenter: new DefaultSlashCommandReplyPresenter(),
    completionPort,
  });
}

describe('slash command control plane', () => {
  test('parser strips group mention and rejects malformed known commands', () => {
    const parser = new SimpleSlashCommandParser();

    assert.deepStrictEqual(parser.tryParse({
      text: '@bot /session ses-2',
      isGroupChat: true,
    }), {
      kind: 'matched',
      command: { kind: 'session', sessionId: 'ses-2' },
    });
    assert.deepStrictEqual(parser.tryParse({
      text: '/model openai',
      isGroupChat: false,
    }), {
      kind: 'invalid',
      command: { kind: 'model' },
    });
    assert.deepStrictEqual(parser.tryParse({
      text: 'hello',
      isGroupChat: false,
    }), { kind: 'none' });
  });

  test('presenter renders stable success and failure text', () => {
    const presenter = new DefaultSlashCommandReplyPresenter();

    assert.strictEqual(
      presenter.presentSuccess({
        kind: 'sessions',
        activeSessionId: 'ses-1',
        sessions: [
          { id: 'ses-1', title: '会话一' },
          { id: 'ses-2', title: '会话二' },
        ],
      }),
      '可切换会话列表\n\n- `ses-1` 会话一（当前）\n- `ses-2` 会话二',
    );
    assert.strictEqual(
      presenter.presentFailure(
        { kind: 'session' },
        { code: 'session_out_of_scope' },
      ),
      '切换会话失败, 目标会话不在当前可切换范围内',
    );
    assert.strictEqual(
      presenter.presentFailure(
        { kind: 'sessions' },
        { code: 'command_disabled_in_group_chat' },
      ),
      '查询会话列表失败, 群聊场景不支持 /sessions，请在单聊中使用',
    );
  });

  test('context resolver reuses recent session and records ownership when binding is absent', async () => {
    const deps = createControlPlaneDependencies();
    const recorder = createLoggerRecorder();
    const context = await createContextResolver(deps).resolve(
      'tool-1',
      { assistantId: 'assistant-1' },
      recorder.logger,
    );

    assert.deepStrictEqual(context, {
      anchor: 'tool-1',
      activeOpencodeSessionId: 'ses-1',
      scope: {
        projectID: 'proj-1',
        workspaceID: 'workspace-1',
        directory: '/workspace',
      },
      modelOverride: undefined,
      bootstrapSource: 'bootstrap_reused_recent_session',
    });
    assert.strictEqual(deps.bindingStore.get('tool-1').activeOpencodeSessionId, 'ses-1');
    assert.strictEqual(deps.ownershipResolver.resolveAttachedAnchor('ses-1'), 'tool-1');
    assert.deepStrictEqual(recorder.infos.map((entry) => entry.event), [
      'slash_context.bootstrap_reused_recent_session',
    ]);
  });

  test('context resolver creates a session when no recent session exists', async () => {
    const deps = createControlPlaneDependencies({ sessions: [] });
    const context = await createContextResolver(deps).resolve('tool-create', {
      assistantId: 'assistant-2',
    });

    assert.strictEqual(context.bootstrapSource, 'bootstrap_created');
    assert.strictEqual(context.activeOpencodeSessionId, 'ses-created-1');
    assert.strictEqual(deps.createdSessions.length, 1);
    assert.deepStrictEqual(deps.createdSessions[0].input, {
      assistantId: 'assistant-2',
    });
  });

  test('orchestrator completes success, applies side effects and forwards rendered text', async () => {
    const deps = createControlPlaneDependencies();
    deps.bindingStore.bind('tool-switch', 'ses-1');
    deps.ownershipResolver.attach('ses-1', 'tool-switch');
    const completion = createCompletionPort();
    const orchestrator = createOrchestrator(deps, completion.port);

    await orchestrator.execute({
      command: { kind: 'session', sessionId: 'ses-2' },
      context: {
        anchor: 'tool-switch',
        activeOpencodeSessionId: 'ses-1',
        scope: {
          projectID: 'proj-1',
          workspaceID: 'workspace-1',
          directory: '/workspace',
        },
        bootstrapSource: 'existing_binding',
      },
      welinkSessionId: 'welink-1',
    });

    assert.deepStrictEqual(completion.calls, [{
      kind: 'success',
      input: {
        anchor: 'tool-switch',
        welinkSessionId: 'welink-1',
        text: '已切换会话 `ses-2` 会话二',
      },
    }]);
    assert.strictEqual(deps.bindingStore.get('tool-switch').activeOpencodeSessionId, 'ses-2');
    assert.strictEqual(deps.ownershipResolver.resolveAttachedAnchor('ses-1'), undefined);
    assert.strictEqual(deps.ownershipResolver.resolveAttachedAnchor('ses-2'), 'tool-switch');
  });

  test('sessions command lists root sessions updated in the TUI 30 day window', async () => {
    const originalNow = Date.now;
    Date.now = () => FIXED_NOW;
    try {
      const listCalls = [];
      const deps = createControlPlaneDependencies({
        hostSessionQueryPort: {
          getSession: async () => ({ id: 'ses-1', directory: '/workspace' }),
          listSessions: async (query) => {
            listCalls.push(query);
            return [{ id: 'ses-1', title: '会话一', directory: '/workspace' }];
          },
        },
      });
      const completion = createCompletionPort();
      const orchestrator = createOrchestrator(deps, completion.port);

      await orchestrator.execute({
        command: { kind: 'sessions' },
        context: {
          anchor: 'tool-sessions',
          activeOpencodeSessionId: 'ses-1',
          scope: {
            projectID: 'proj-ignored',
            workspaceID: 'workspace-ignored',
            directory: '/workspace',
          },
          bootstrapSource: 'existing_binding',
        },
        welinkSessionId: 'welink-1',
      });

      assert.deepStrictEqual(listCalls, [{
        directory: '/workspace',
        roots: true,
        start: FIXED_NOW - TUI_SESSION_LIST_WINDOW_MS,
      }]);
      assert.strictEqual(completion.calls[0].kind, 'success');
    } finally {
      Date.now = originalNow;
    }
  });

  test('session command uses the same TUI visible session window as sessions command', async () => {
    const originalNow = Date.now;
    Date.now = () => FIXED_NOW;
    try {
      const listCalls = [];
      const deps = createControlPlaneDependencies({
        hostSessionQueryPort: {
          getSession: async () => ({ id: 'ses-current', directory: '/workspace' }),
          listSessions: async (query) => {
            listCalls.push(query);
            return [{ id: 'ses-target', title: '目标会话', directory: '/workspace' }];
          },
        },
      });
      deps.bindingStore.bind('tool-switch-window', 'ses-current');
      deps.ownershipResolver.attach('ses-current', 'tool-switch-window');
      const completion = createCompletionPort();
      const orchestrator = createOrchestrator(deps, completion.port);

      await orchestrator.execute({
        command: { kind: 'session', sessionId: 'ses-target' },
        context: {
          anchor: 'tool-switch-window',
          activeOpencodeSessionId: 'ses-current',
          scope: {
            directory: '/workspace',
          },
          bootstrapSource: 'existing_binding',
        },
        welinkSessionId: 'welink-1',
      });

      assert.deepStrictEqual(listCalls, [{
        directory: '/workspace',
        roots: true,
        start: FIXED_NOW - TUI_SESSION_LIST_WINDOW_MS,
      }]);
      assert.strictEqual(deps.bindingStore.get('tool-switch-window').activeOpencodeSessionId, 'ses-target');
    } finally {
      Date.now = originalNow;
    }
  });

  test('orchestrator completes failure with normalized reason', async () => {
    const deps = createControlPlaneDependencies();
    const completion = createCompletionPort();
    const orchestrator = createOrchestrator(deps, completion.port);

    await orchestrator.execute({
      command: { kind: 'model', providerId: 'openai', modelId: 'missing' },
      context: {
        anchor: 'tool-model',
        activeOpencodeSessionId: 'ses-1',
        bootstrapSource: 'existing_binding',
      },
    });

    assert.deepStrictEqual(completion.calls, [{
      kind: 'failure',
      input: {
        anchor: 'tool-model',
        welinkSessionId: undefined,
        text: '设置模型失败,目标模型不存在或当前宿主不可用',
      },
    }]);
  });

  test('orchestrator logs delivery failure without throwing', async () => {
    const deps = createControlPlaneDependencies();
    const completion = createCompletionPort({
      success: false,
      failureStage: 'message.part.delta.text',
    });
    const recorder = createLoggerRecorder();
    const orchestrator = createOrchestrator(deps, completion.port);

    await orchestrator.completeFailure({
      command: { kind: 'sessions' },
      anchor: 'tool-failure',
      welinkSessionId: 'welink-failure',
      error: { code: 'sdk_unreachable' },
      logger: recorder.logger,
    });

    assert.deepStrictEqual(completion.calls, [{
      kind: 'failure',
      input: {
        anchor: 'tool-failure',
        welinkSessionId: 'welink-failure',
        text: '查询会话列表失败, 当前宿主不可用',
      },
    }]);
    assert.deepStrictEqual(recorder.errors, [{
      event: 'runtime.slash.synthetic_reply_delivery_failed',
      fields: {
        anchor: 'tool-failure',
        toolSessionId: 'tool-failure',
        command: 'sessions',
        failureStage: 'message.part.delta.text',
        messageType: 'message.part.delta',
        completionSource: 'slash_control_plane',
        completionKind: 'failure',
      },
    }]);
  });
});
