import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryOpencodeSessionOwnershipResolver,
  InMemorySessionModelOverrideStore,
  InMemoryToolSessionBindingStore,
  SimpleSlashCommandParser,
} from '../../src/adapter/index.ts';
import {
  BindingAwareChatRouter,
  MemoryGatewayEnvelopeProjector,
  RuntimeSlashCommandCompletionPort,
} from '../../src/runtime/index.ts';
import {
  DefaultSlashCommandOrchestrator,
  DefaultSlashCommandReplyPresenter,
  ResolveSlashCommandContextUseCase,
} from '../../src/usecase/index.ts';

function createLoggerStub() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child() {
      return this;
    },
    getTraceId: () => 'trace-test',
  };
}

describe('SimpleSlashCommandParser', () => {
  test('parses supported commands and ignores non-slash text', () => {
    const parser = new SimpleSlashCommandParser();

    assert.strictEqual(parser.tryParse('hello world'), undefined);
    assert.deepStrictEqual(parser.tryParse('/new'), { kind: 'new' });
    assert.deepStrictEqual(parser.tryParse('/sessions'), { kind: 'sessions' });
    assert.deepStrictEqual(parser.tryParse('/session ses-2'), { kind: 'session', sessionId: 'ses-2' });
    assert.deepStrictEqual(parser.tryParse('/models'), { kind: 'models' });
    assert.deepStrictEqual(parser.tryParse('/model openai/gpt-5.4'), {
      kind: 'model',
      providerId: 'openai',
      modelId: 'gpt-5.4',
    });
  });
});

describe('control-plane memory stores', () => {
  test('binding store invalidates and rebinds anchor', () => {
    const store = new InMemoryToolSessionBindingStore();

    assert.strictEqual(store.get('tool-1'), undefined);
    assert.deepStrictEqual(store.bind('tool-1', 'ses-1'), {
      anchor: 'tool-1',
      activeOpencodeSessionId: 'ses-1',
      status: 'active',
    });
    assert.deepStrictEqual(store.get('tool-1'), {
      anchor: 'tool-1',
      activeOpencodeSessionId: 'ses-1',
      status: 'active',
    });

    store.invalidate('tool-1');
    assert.deepStrictEqual(store.get('tool-1'), {
      anchor: 'tool-1',
      activeOpencodeSessionId: 'ses-1',
      status: 'invalid',
    });

    assert.deepStrictEqual(store.bind('tool-1', 'ses-2'), {
      anchor: 'tool-1',
      activeOpencodeSessionId: 'ses-2',
      status: 'active',
    });
  });

  test('ownership resolver detaches previous owner when anchor is rebound', () => {
    const resolver = new InMemoryOpencodeSessionOwnershipResolver();

    resolver.attach('ses-1', 'tool-1');
    assert.strictEqual(resolver.resolveAttachedAnchor('ses-1'), 'tool-1');

    resolver.attach('ses-2', 'tool-1');
    assert.strictEqual(resolver.resolveAttachedAnchor('ses-1'), undefined);
    assert.strictEqual(resolver.resolveAttachedAnchor('ses-2'), 'tool-1');

    resolver.detach('ses-2');
    assert.strictEqual(resolver.resolveAttachedAnchor('ses-2'), undefined);
  });

  test('model override store is keyed by opencode session id', () => {
    const store = new InMemorySessionModelOverrideStore();

    assert.strictEqual(store.get('ses-1'), undefined);
    store.set('ses-1', { providerId: 'openai', modelId: 'gpt-5.4' });
    assert.deepStrictEqual(store.get('ses-1'), { providerId: 'openai', modelId: 'gpt-5.4' });
    assert.strictEqual(store.get('ses-2'), undefined);
    store.clear('ses-1');
    assert.strictEqual(store.get('ses-1'), undefined);
  });
});

describe('BindingAwareChatRouter', () => {
  test('bootstraps first chat and prompts active session', async () => {
    const prompts = [];
    const hostSessionCreationPort = {
      async createSession() {
        return {
          id: 'ses-bootstrap',
          title: 'bootstrap',
          directory: '/tmp/bootstrap',
        };
      },
    };
    const hostSessionQueryPort = {
      async getSession(sessionId) {
        return { id: sessionId, title: sessionId, directory: '/tmp/bootstrap' };
      },
      async listSessions() {
        return [];
      },
    };
    const hostPromptExecutionPort = {
      async prompt(input) {
        prompts.push(input);
      },
    };
    const modelStore = new InMemorySessionModelOverrideStore();
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const contextResolver = new ResolveSlashCommandContextUseCase({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: modelStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
    });
    const parser = new SimpleSlashCommandParser();
    const replyPresenter = new DefaultSlashCommandReplyPresenter();
    const projected = [];
    const completionPort = new RuntimeSlashCommandCompletionPort({
      projector: new MemoryGatewayEnvelopeProjector(),
      sender: async (message) => {
        projected.push(message);
      },
    });
    const orchestrator = new DefaultSlashCommandOrchestrator({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: modelStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
      hostPromptExecutionPort,
      hostModelCatalogPort: {
        async listModels() {
          return [];
        },
      },
      replyPresenter,
      completionPort,
    });

    const router = new BindingAwareChatRouter({
      contextResolver,
      slashCommandParser: parser,
      slashCommandOrchestrator: orchestrator,
      hostPromptExecutionPort,
    });

    const result = await router.route({
      anchor: 'tool-bootstrap',
      text: 'hello',
      assistantId: 'persona-1',
      logger: createLoggerStub(),
    });

    assert.deepStrictEqual(result, { kind: 'chat_forwarded', sessionId: 'ses-bootstrap' });
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].sessionId, 'ses-bootstrap');
    assert.strictEqual(prompts[0].text, 'hello');
    assert.strictEqual(prompts[0].assistantId, 'persona-1');
    assert.strictEqual(prompts[0].modelOverride, undefined);
    assert.ok(prompts[0].logger);
    assert.deepStrictEqual(bindingStore.get('tool-bootstrap'), {
      anchor: 'tool-bootstrap',
      activeOpencodeSessionId: 'ses-bootstrap',
      status: 'active',
    });
    assert.strictEqual(ownershipResolver.resolveAttachedAnchor('ses-bootstrap'), 'tool-bootstrap');
    assert.deepStrictEqual(projected, []);
  });

  test('slash new rotates ownership and emits tool_event plus tool_done', async () => {
    const created = [];
    const prompts = [];
    const hostSessionCreationPort = {
      async createSession() {
        const id = created.length === 0 ? 'ses-bootstrap' : 'ses-new';
        created.push(id);
        return { id, title: id, directory: `/tmp/${id}` };
      },
    };
    const hostSessionQueryPort = {
      async getSession(sessionId) {
        return { id: sessionId, title: sessionId, directory: `/tmp/${sessionId}` };
      },
      async listSessions() {
        return [];
      },
    };
    const hostPromptExecutionPort = {
      async prompt(input) {
        prompts.push(input);
      },
    };
    const modelStore = new InMemorySessionModelOverrideStore();
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const contextResolver = new ResolveSlashCommandContextUseCase({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: modelStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
    });
    const projected = [];
    const completionPort = new RuntimeSlashCommandCompletionPort({
      projector: new MemoryGatewayEnvelopeProjector(),
      sender: async (message) => {
        projected.push(message);
      },
    });
    const router = new BindingAwareChatRouter({
      contextResolver,
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCommandOrchestrator: new DefaultSlashCommandOrchestrator({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
        hostPromptExecutionPort,
        hostModelCatalogPort: {
          async listModels() {
            return [];
          },
        },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort,
      }),
      hostPromptExecutionPort,
    });

    await router.route({ anchor: 'tool-1', text: 'hello', logger: createLoggerStub() });
    const result = await router.route({ anchor: 'tool-1', text: '/new', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assert.strictEqual(prompts.length, 1);
    assert.deepStrictEqual(bindingStore.get('tool-1'), {
      anchor: 'tool-1',
      activeOpencodeSessionId: 'ses-new',
      status: 'active',
    });
    assert.strictEqual(ownershipResolver.resolveAttachedAnchor('ses-bootstrap'), undefined);
    assert.strictEqual(ownershipResolver.resolveAttachedAnchor('ses-new'), 'tool-1');
    assert.strictEqual(projected.length, 2);
    assert.strictEqual(projected[0].type, 'tool_event');
    assert.strictEqual(projected[0].toolSessionId, 'tool-1');
    assert.strictEqual(projected[0].event.properties.part.text.includes('ses-new'), true);
    assert.deepStrictEqual(projected[1], {
      type: 'tool_done',
      toolSessionId: 'tool-1',
    });
  });

  test('slash new uses unified failure template and does not expose raw host error', async () => {
    let createCount = 0;
    const hostSessionCreationPort = {
      async createSession() {
        createCount += 1;
        if (createCount === 1) {
          return { id: 'ses-bootstrap', title: 'bootstrap', directory: '/tmp/bootstrap' };
        }
        throw new Error('raw host create failure');
      },
    };
    const hostSessionQueryPort = {
      async getSession(sessionId) {
        return { id: sessionId, title: sessionId, directory: `/tmp/${sessionId}` };
      },
      async listSessions() {
        return [];
      },
    };
    const projected = [];
    const modelStore = new InMemorySessionModelOverrideStore();
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const contextResolver = new ResolveSlashCommandContextUseCase({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: modelStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
    });
    const router = new BindingAwareChatRouter({
      contextResolver,
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCommandOrchestrator: new DefaultSlashCommandOrchestrator({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
        hostPromptExecutionPort: { async prompt() {} },
        hostModelCatalogPort: { async listModels() { return []; } },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: async (message) => projected.push(message),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-new-fail', text: 'hello', logger: createLoggerStub() });
    const result = await router.route({ anchor: 'tool-new-fail', text: '/new', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assert.strictEqual(projected[0].type, 'tool_error');
    assert.strictEqual(projected[0].error, '新建会话失败 当前宿主不可用');
  });

  test('slash sessions lists scoped sessions and marks current session in presenter output', async () => {
    const hostSessionCreationPort = {
      async createSession() {
        return {
          id: 'ses-bootstrap',
          title: 'bootstrap',
          projectID: 'proj-1',
          workspaceID: 'ws-1',
          directory: '/tmp/proj-1',
        };
      },
    };
    const hostSessionQueryPort = {
      async getSession(sessionId) {
        return {
          id: sessionId,
          title: 'bootstrap',
          projectID: 'proj-1',
          workspaceID: 'ws-1',
          directory: '/tmp/proj-1',
        };
      },
      async listSessions(scope) {
        assert.deepStrictEqual(scope, {
          projectID: 'proj-1',
          workspaceID: 'ws-1',
          directory: '/tmp/proj-1',
        });
        return [
          { id: 'ses-bootstrap', title: '当前会话', projectID: 'proj-1', workspaceID: 'ws-1', directory: '/tmp/proj-1' },
          { id: 'ses-2', title: '第二个会话', projectID: 'proj-1', workspaceID: 'ws-1', directory: '/tmp/proj-1' },
        ];
      },
    };
    const projected = [];
    const modelStore = new InMemorySessionModelOverrideStore();
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const contextResolver = new ResolveSlashCommandContextUseCase({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: modelStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
    });
    const router = new BindingAwareChatRouter({
      contextResolver,
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCommandOrchestrator: new DefaultSlashCommandOrchestrator({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
        hostPromptExecutionPort: { async prompt() {} },
        hostModelCatalogPort: { async listModels() { return []; } },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: async (message) => projected.push(message),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-sessions', text: 'hello', logger: createLoggerStub() });
    const result = await router.route({ anchor: 'tool-sessions', text: '/sessions', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assert.strictEqual(projected[0].type, 'tool_event');
    assert.strictEqual(
      projected[0].event.properties.part.text,
      '可切换会话列表\n\n- `ses-bootstrap` 当前会话（当前）\n- `ses-2` 第二个会话',
    );
  });

  test('slash session rejects targets outside current scope with fixed failure text', async () => {
    const hostSessionCreationPort = {
      async createSession() {
        return {
          id: 'ses-bootstrap',
          title: 'bootstrap',
          projectID: 'proj-1',
          workspaceID: 'ws-1',
          directory: '/tmp/proj-1',
        };
      },
    };
    const hostSessionQueryPort = {
      async getSession(sessionId) {
        if (sessionId === 'ses-bootstrap') {
          return {
            id: 'ses-bootstrap',
            title: 'bootstrap',
            projectID: 'proj-1',
            workspaceID: 'ws-1',
            directory: '/tmp/proj-1',
          };
        }
        return {
          id: sessionId,
          title: '越界会话',
          projectID: 'proj-2',
          workspaceID: 'ws-2',
          directory: '/tmp/proj-2',
        };
      },
      async listSessions() {
        return [];
      },
    };
    const projected = [];
    const modelStore = new InMemorySessionModelOverrideStore();
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const contextResolver = new ResolveSlashCommandContextUseCase({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: modelStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
    });
    const router = new BindingAwareChatRouter({
      contextResolver,
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCommandOrchestrator: new DefaultSlashCommandOrchestrator({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
        hostPromptExecutionPort: { async prompt() {} },
        hostModelCatalogPort: { async listModels() { return []; } },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: async (message) => projected.push(message),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-switch', text: 'hello', logger: createLoggerStub() });
    const result = await router.route({ anchor: 'tool-switch', text: '/session ses-2', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assert.strictEqual(projected[0].type, 'tool_error');
    assert.strictEqual(projected[0].error, '切换会话失败, 目标会话不在当前 project/workspace 可切换范围内');
    assert.deepStrictEqual(bindingStore.get('tool-switch'), {
      anchor: 'tool-switch',
      activeOpencodeSessionId: 'ses-bootstrap',
      status: 'active',
    });
  });

  test('slash sessions uses unified failure template and does not expose raw host error', async () => {
    const hostSessionCreationPort = {
      async createSession() {
        return {
          id: 'ses-bootstrap',
          title: 'bootstrap',
          projectID: 'proj-1',
          workspaceID: 'ws-1',
          directory: '/tmp/proj-1',
        };
      },
    };
    const hostSessionQueryPort = {
      async getSession(sessionId) {
        return {
          id: sessionId,
          title: 'bootstrap',
          projectID: 'proj-1',
          workspaceID: 'ws-1',
          directory: '/tmp/proj-1',
        };
      },
      async listSessions() {
        throw new Error('raw session list failure');
      },
    };
    const projected = [];
    const modelStore = new InMemorySessionModelOverrideStore();
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const contextResolver = new ResolveSlashCommandContextUseCase({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: modelStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
    });
    const router = new BindingAwareChatRouter({
      contextResolver,
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCommandOrchestrator: new DefaultSlashCommandOrchestrator({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
        hostPromptExecutionPort: { async prompt() {} },
        hostModelCatalogPort: { async listModels() { return []; } },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: async (message) => projected.push(message),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-sessions-fail', text: 'hello', logger: createLoggerStub() });
    const result = await router.route({ anchor: 'tool-sessions-fail', text: '/sessions', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assert.strictEqual(projected[0].type, 'tool_error');
    assert.strictEqual(projected[0].error, '查询会话列表失败, 当前宿主不可用');
  });

  test('slash context resolution failure still uses unified failure template', async () => {
    const hostSessionCreationPort = {
      async createSession() {
        return {
          id: 'ses-bootstrap',
          title: 'bootstrap',
          directory: '/tmp/bootstrap',
        };
      },
    };
    const hostSessionQueryPort = {
      async getSession(sessionId) {
        if (sessionId === 'ses-bootstrap') {
          throw {
            errorCode: 'SDK_UNREACHABLE',
            errorMessage: 'Failed to send message',
            errorEvidence: { sourceErrorCode: 'session_not_found', sourceOperation: 'session.get' },
          };
        }
        return { id: sessionId, title: sessionId, directory: `/tmp/${sessionId}` };
      },
      async listSessions() {
        return [];
      },
    };
    const projected = [];
    const modelStore = new InMemorySessionModelOverrideStore();
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const contextResolver = new ResolveSlashCommandContextUseCase({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: modelStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
    });
    const router = new BindingAwareChatRouter({
      contextResolver,
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCommandOrchestrator: new DefaultSlashCommandOrchestrator({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
        hostPromptExecutionPort: { async prompt() {} },
        hostModelCatalogPort: { async listModels() { return []; } },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: async (message) => projected.push(message),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-context-fail', text: 'hello', logger: createLoggerStub() });
    await assert.rejects(
      router.route({ anchor: 'tool-context-fail', text: '/sessions', logger: createLoggerStub() }),
      /slash_command\.failure_handled/u,
    );

    assert.strictEqual(projected[0].type, 'tool_error');
    assert.strictEqual(projected[0].error, '查询会话列表失败, 当前没有可用会话');
  });

  test('slash model applies override only to the current active session and chat uses that override after session switch', async () => {
    const prompts = [];
    const hostSessionCreationPort = {
      async createSession() {
        return {
          id: 'ses-1',
          title: '会话一',
          projectID: 'proj-1',
          workspaceID: 'ws-1',
          directory: '/tmp/proj-1',
        };
      },
    };
    const sessions = new Map([
      ['ses-1', { id: 'ses-1', title: '会话一', projectID: 'proj-1', workspaceID: 'ws-1', directory: '/tmp/proj-1' }],
      ['ses-2', { id: 'ses-2', title: '会话二', projectID: 'proj-1', workspaceID: 'ws-1', directory: '/tmp/proj-1' }],
    ]);
    const hostSessionQueryPort = {
      async getSession(sessionId) {
        return sessions.get(sessionId);
      },
      async listSessions() {
        return [...sessions.values()];
      },
    };
    const hostPromptExecutionPort = {
      async prompt(input) {
        prompts.push(input);
      },
    };
    const projected = [];
    const modelStore = new InMemorySessionModelOverrideStore();
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const contextResolver = new ResolveSlashCommandContextUseCase({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: modelStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
    });
    const router = new BindingAwareChatRouter({
      contextResolver,
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCommandOrchestrator: new DefaultSlashCommandOrchestrator({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
        hostPromptExecutionPort,
        hostModelCatalogPort: {
          async listModels() {
            return [
              { providerId: 'openai', modelId: 'gpt-5.4' },
              { providerId: 'anthropic', modelId: 'claude-sonnet-4' },
            ];
          },
        },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: async (message) => projected.push(message),
        }),
      }),
      hostPromptExecutionPort,
    });

    await router.route({ anchor: 'tool-model', text: 'hello', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-model', text: '/model openai/gpt-5.4', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-model', text: 'first prompt', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-model', text: '/session ses-2', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-model', text: 'second prompt', logger: createLoggerStub() });

    assert.strictEqual(projected[0].event.properties.part.text, '后续请求将使用该模型 openai/gpt-5.4');
    assert.strictEqual(projected[2].event.properties.part.text, '已切换会话 `ses-2` 会话二');
    assert.deepStrictEqual(prompts, [
      {
        sessionId: 'ses-1',
        text: 'hello',
        assistantId: undefined,
        modelOverride: undefined,
        logger: prompts[0].logger,
      },
      {
        sessionId: 'ses-1',
        text: 'first prompt',
        assistantId: undefined,
        modelOverride: { providerId: 'openai', modelId: 'gpt-5.4' },
        logger: prompts[1].logger,
      },
      {
        sessionId: 'ses-2',
        text: 'second prompt',
        assistantId: undefined,
        modelOverride: undefined,
        logger: prompts[2].logger,
      },
    ]);
    assert.deepStrictEqual(modelStore.get('ses-1'), { providerId: 'openai', modelId: 'gpt-5.4' });
    assert.strictEqual(modelStore.get('ses-2'), undefined);
  });

  test('slash models renders markdown list and slash model missing target returns fixed failure text', async () => {
    const hostSessionCreationPort = {
      async createSession() {
        return { id: 'ses-1', title: '会话一', directory: '/tmp/proj-1' };
      },
    };
    const hostSessionQueryPort = {
      async getSession(sessionId) {
        return { id: sessionId, title: '会话一', directory: '/tmp/proj-1' };
      },
      async listSessions() {
        return [];
      },
    };
    const projected = [];
    const modelStore = new InMemorySessionModelOverrideStore();
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const contextResolver = new ResolveSlashCommandContextUseCase({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: modelStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
    });
    const router = new BindingAwareChatRouter({
      contextResolver,
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCommandOrchestrator: new DefaultSlashCommandOrchestrator({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
        hostPromptExecutionPort: { async prompt() {} },
        hostModelCatalogPort: {
          async listModels() {
            return [
              { providerId: 'openai', modelId: 'gpt-5.4' },
              { providerId: 'anthropic', modelId: 'claude-sonnet-4' },
            ];
          },
        },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: async (message) => projected.push(message),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-models', text: 'hello', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-models', text: '/models', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-models', text: '/model openai/not-exists', logger: createLoggerStub() });

    assert.strictEqual(
      projected[0].event.properties.part.text,
      '可用模型列表\n\n- `openai/gpt-5.4`\n- `anthropic/claude-sonnet-4`',
    );
    assert.strictEqual(projected[2].error, '设置模型失败,目标模型不存在或当前宿主不可用');
  });
});
