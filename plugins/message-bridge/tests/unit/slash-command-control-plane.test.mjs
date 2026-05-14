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

function createRecordingLogger() {
  const errors = [];
  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (event, fields) => {
        errors.push({ event, fields });
      },
      child() {
        return this;
      },
      getTraceId: () => 'trace-test',
    },
    errors,
  };
}

function assertSyntheticAssistantReply(projected, index, toolSessionId, expectedText) {
  assert.strictEqual(projected[index].type, 'tool_event');
  assert.strictEqual(projected[index].toolSessionId, toolSessionId);
  assert.strictEqual(projected[index].event.type, 'message.updated');
  assert.strictEqual(projected[index].event.properties.info.role, 'assistant');

  const messageId = projected[index].event.properties.info.id;
  assert.match(messageId, /^msg_[a-f0-9]{32}$/);

  const stepStart = projected[index + 1];
  const text = projected[index + 2];
  const stepFinish = projected[index + 3];

  assert.strictEqual(stepStart.type, 'tool_event');
  assert.strictEqual(stepStart.event.type, 'message.part.updated');
  assert.strictEqual(stepStart.event.properties.part.type, 'step-start');
  assert.strictEqual(stepStart.event.properties.part.messageID, messageId);

  assert.strictEqual(text.type, 'tool_event');
  assert.strictEqual(text.event.type, 'message.part.updated');
  assert.strictEqual(text.event.properties.part.type, 'text');
  assert.strictEqual(text.event.properties.part.messageID, messageId);
  assert.strictEqual(text.event.properties.part.text, expectedText);

  assert.strictEqual(stepFinish.type, 'tool_event');
  assert.strictEqual(stepFinish.event.type, 'message.part.updated');
  assert.strictEqual(stepFinish.event.properties.part.type, 'step-finish');
  assert.strictEqual(stepFinish.event.properties.part.messageID, messageId);
  assert.strictEqual(stepFinish.event.properties.part.reason, 'stop');
}

function createCompletionPortSenderStub(projected, options = {}) {
  const failAtCall = options.failAtCall;
  let callCount = 0;
  return async (message) => {
    callCount += 1;
    projected.push(message);
    if (callCount === failAtCall) {
      return false;
    }
    return true;
  };
}

describe('SimpleSlashCommandParser', () => {
  test('parses supported commands, invalid known commands, and group mention prefix cases', () => {
    const parser = new SimpleSlashCommandParser();

    assert.deepStrictEqual(parser.tryParse({ text: 'hello', isGroupChat: false }), { kind: 'none' });
    assert.deepStrictEqual(parser.tryParse({ text: '/sessions', isGroupChat: false }), {
      kind: 'matched',
      command: { kind: 'sessions' },
    });
    assert.deepStrictEqual(parser.tryParse({ text: '/sessions fdsfs', isGroupChat: false }), {
      kind: 'invalid',
      command: { kind: 'sessions' },
    });
    assert.deepStrictEqual(parser.tryParse({ text: '/new foo', isGroupChat: false }), {
      kind: 'invalid',
      command: { kind: 'new' },
    });
    assert.deepStrictEqual(parser.tryParse({ text: '/session', isGroupChat: false }), {
      kind: 'invalid',
      command: { kind: 'session' },
    });
    assert.deepStrictEqual(parser.tryParse({ text: '/session ses-2', isGroupChat: false }), {
      kind: 'matched',
      command: { kind: 'session', sessionId: 'ses-2' },
    });
    assert.deepStrictEqual(parser.tryParse({ text: '/model openai', isGroupChat: false }), {
      kind: 'invalid',
      command: { kind: 'model' },
    });
    assert.deepStrictEqual(parser.tryParse({ text: '/model openai/gpt-5.4', isGroupChat: false }), {
      kind: 'matched',
      command: {
        kind: 'model',
        providerId: 'openai',
        modelId: 'gpt-5.4',
      },
    });
    assert.deepStrictEqual(parser.tryParse({ text: '/abc', isGroupChat: false }), { kind: 'none' });
    assert.deepStrictEqual(parser.tryParse({ text: '@bot /sessions', isGroupChat: true }), {
      kind: 'matched',
      command: { kind: 'sessions' },
    });
    assert.deepStrictEqual(parser.tryParse({ text: '@bot /sessions fdsfs', isGroupChat: true }), {
      kind: 'invalid',
      command: { kind: 'sessions' },
    });
    assert.deepStrictEqual(parser.tryParse({ text: '@bot /sessions', isGroupChat: false }), {
      kind: 'none',
    });
  });
});

describe('RuntimeSlashCommandCompletionPort', () => {
  test('completeFailure sends synthetic assistant failure reply only', async () => {
    const projected = [];
    const completionPort = new RuntimeSlashCommandCompletionPort({
      projector: new MemoryGatewayEnvelopeProjector(),
      sender: createCompletionPortSenderStub(projected),
    });

    const result = await completionPort.completeFailure({
      anchor: 'tool-failure-only',
      text: '查询会话列表失败, 当前宿主不可用',
    });

    assert.deepStrictEqual(result, { success: true });
    assert.strictEqual(projected.length, 4);
    assertSyntheticAssistantReply(projected, 0, 'tool-failure-only', '查询会话列表失败, 当前宿主不可用');
    assert.strictEqual(projected.some((message) => message.type === 'tool_error'), false);
    assert.strictEqual(projected.some((message) => message.type === 'tool_done'), false);
  });

  test('completeFailure returns delivery failure when sender returns false', async () => {
    const projected = [];
    const completionPort = new RuntimeSlashCommandCompletionPort({
      projector: new MemoryGatewayEnvelopeProjector(),
      sender: createCompletionPortSenderStub(projected, { failAtCall: 1 }),
    });

    const result = await completionPort.completeFailure({
      anchor: 'tool-failure-false',
      text: '失败回包半路终止',
    });

    assert.deepStrictEqual(result, {
      success: false,
      failureStage: 'message.updated',
    });
    assert.strictEqual(projected.length, 1);
    assert.strictEqual(projected[0].event.type, 'message.updated');
    assert.strictEqual(projected.some((message) => message.type === 'tool_error'), false);
    assert.strictEqual(projected.some((message) => message.type === 'tool_done'), false);
  });

  test('completeFailure returns delivery failure when sender throws', async () => {
    const projected = [];
    const completionPort = new RuntimeSlashCommandCompletionPort({
      projector: new MemoryGatewayEnvelopeProjector(),
      sender: async (message) => {
        projected.push(message);
        throw new Error('send exploded');
      },
    });

    const result = await completionPort.completeFailure({
      anchor: 'tool-failure-throw',
      text: '失败回包抛异常',
    });

    assert.deepStrictEqual(result, {
      success: false,
      failureStage: 'message.updated',
    });
    assert.strictEqual(projected.length, 1);
    assert.strictEqual(projected[0].event.type, 'message.updated');
    assert.strictEqual(projected.some((message) => message.type === 'tool_error'), false);
    assert.strictEqual(projected.some((message) => message.type === 'tool_done'), false);
  });

  test('completeFailure returns matching stage when mid-sequence delivery fails', async () => {
    const projected = [];
    const completionPort = new RuntimeSlashCommandCompletionPort({
      projector: new MemoryGatewayEnvelopeProjector(),
      sender: createCompletionPortSenderStub(projected, { failAtCall: 3 }),
    });

    const result = await completionPort.completeFailure({
      anchor: 'tool-failure-mid',
      text: '第三段失败',
    });

    assert.deepStrictEqual(result, {
      success: false,
      failureStage: 'message.part.updated.text',
    });
    assert.strictEqual(projected.length, 3);
    assert.strictEqual(projected[0].event.type, 'message.updated');
    assert.strictEqual(projected[1].event.properties.part.type, 'step-start');
    assert.strictEqual(projected[2].event.properties.part.type, 'text');
    assert.strictEqual(projected.some((message) => message.type === 'tool_error'), false);
    assert.strictEqual(projected.some((message) => message.type === 'tool_done'), false);
  });

  test('completeSuccess returns delivery failure when a synthetic reply event cannot be sent', async () => {
    const projected = [];
    const completionPort = new RuntimeSlashCommandCompletionPort({
      projector: new MemoryGatewayEnvelopeProjector(),
      sender: createCompletionPortSenderStub(projected, { failAtCall: 3 }),
    });

    const result = await completionPort.completeSuccess({
      anchor: 'tool-send-fail',
      text: '不会完整发送',
    });

    assert.deepStrictEqual(result, {
      success: false,
      failureStage: 'message.part.updated.text',
    });
    assert.strictEqual(projected.length, 3);
    assert.strictEqual(projected[0].event.type, 'message.updated');
    assert.strictEqual(projected[1].event.properties.part.type, 'step-start');
    assert.strictEqual(projected[2].event.properties.part.type, 'text');
    assert.strictEqual(projected[2].event.properties.part.text, '不会完整发送');
  });

  test('completeSuccess returns delivery failure when tool_done cannot be sent', async () => {
    const projected = [];
    const completionPort = new RuntimeSlashCommandCompletionPort({
      projector: new MemoryGatewayEnvelopeProjector(),
      sender: createCompletionPortSenderStub(projected, { failAtCall: 5 }),
    });

    const result = await completionPort.completeSuccess({
      anchor: 'tool-tool-done-fail',
      text: '会先发出成功回复',
    });

    assert.deepStrictEqual(result, {
      success: false,
      failureStage: 'tool_done',
    });
    assert.strictEqual(projected.length, 5);
    assertSyntheticAssistantReply(projected, 0, 'tool-tool-done-fail', '会先发出成功回复');
    assert.deepStrictEqual(projected[4], {
      type: 'tool_done',
      toolSessionId: 'tool-tool-done-fail',
    });
  });

  test('completeSuccess returns delivery failure when sender throws', async () => {
    const projected = [];
    const completionPort = new RuntimeSlashCommandCompletionPort({
      projector: new MemoryGatewayEnvelopeProjector(),
      sender: async (message) => {
        projected.push(message);
        throw new Error('send exploded');
      },
    });

    const result = await completionPort.completeSuccess({
      anchor: 'tool-send-throw',
      text: '发送器抛异常',
    });

    assert.deepStrictEqual(result, {
      success: false,
      failureStage: 'message.updated',
    });
    assert.strictEqual(projected.length, 1);
    assert.strictEqual(projected[0].event.type, 'message.updated');
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
  test('invalid known slash command completes with failure reply and does not prompt host', async () => {
    const prompts = [];
    const projected = [];
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const modelStore = new InMemorySessionModelOverrideStore();
    const hostSessionCreationPort = {
      async createSession() {
        throw new Error('createSession should not be called');
      },
    };
    const hostSessionQueryPort = {
      async getSession() {
        throw new Error('getSession should not be called');
      },
      async listSessions() {
        throw new Error('listSessions should not be called');
      },
    };
    const router = new BindingAwareChatRouter({
      contextResolver: new ResolveSlashCommandContextUseCase({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
      }),
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCommandOrchestrator: new DefaultSlashCommandOrchestrator({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
        hostPromptExecutionPort: {
          async prompt(input) {
            prompts.push(input);
          },
        },
        hostModelCatalogPort: { async listModels() { return []; } },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: createCompletionPortSenderStub(projected),
        }),
      }),
      hostPromptExecutionPort: {
        async prompt(input) {
          prompts.push(input);
        },
      },
    });

    const result = await router.route({ anchor: 'tool-invalid-slash', text: '/sessions fdsfs', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assert.deepStrictEqual(prompts, []);
    assertSyntheticAssistantReply(projected, 0, 'tool-invalid-slash', '查询会话列表失败, 命令不受支持');
    assert.strictEqual(projected.some((message) => message.type === 'tool_error'), false);
  });

  test('invalid known slash command remains handled when failure reply sender throws', async () => {
    const prompts = [];
    const { logger, errors } = createRecordingLogger();
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const modelStore = new InMemorySessionModelOverrideStore();
    const router = new BindingAwareChatRouter({
      contextResolver: new ResolveSlashCommandContextUseCase({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort: { async createSession() { throw new Error('should not create'); } },
        hostSessionQueryPort: {
          async getSession() { throw new Error('should not get'); },
          async listSessions() { throw new Error('should not list'); },
        },
      }),
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCommandOrchestrator: new DefaultSlashCommandOrchestrator({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort: { async createSession() { throw new Error('should not create'); } },
        hostSessionQueryPort: {
          async getSession() { throw new Error('should not get'); },
          async listSessions() { throw new Error('should not list'); },
        },
        hostPromptExecutionPort: { async prompt(input) { prompts.push(input); } },
        hostModelCatalogPort: { async listModels() { return []; } },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: async () => {
            throw new Error('send exploded');
          },
        }),
      }),
      hostPromptExecutionPort: { async prompt(input) { prompts.push(input); } },
    });

    const result = await router.route({ anchor: 'tool-invalid-send-throw', text: '/sessions fdsfs', logger });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assert.deepStrictEqual(prompts, []);
    assert.deepStrictEqual(errors, [
      {
        event: 'runtime.slash.synthetic_reply_delivery_failed',
        fields: {
          anchor: 'tool-invalid-send-throw',
          toolSessionId: 'tool-invalid-send-throw',
          command: 'sessions',
          failureStage: 'message.updated',
          messageType: 'message.updated',
          completionSource: 'slash_control_plane',
          completionKind: 'failure',
        },
      },
    ]);
  });

  test('bootstraps first chat by reusing the most recent session and prompts active session', async () => {
    const prompts = [];
    let createCalls = 0;
    const hostSessionCreationPort = {
      async createSession() {
        createCalls += 1;
        return {
          id: 'ses-bootstrap',
          title: 'bootstrap',
          directory: '/tmp/bootstrap',
        };
      },
    };
    const hostSessionQueryPort = {
      async getSession(sessionId) {
        return { id: sessionId, title: sessionId, directory: '/tmp/recent' };
      },
      async listSessions() {
        return [{ id: 'ses-recent', title: 'recent', directory: '/tmp/recent' }];
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
      sender: createCompletionPortSenderStub(projected),
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

    assert.deepStrictEqual(result, { kind: 'chat_forwarded', sessionId: 'ses-recent' });
    assert.strictEqual(createCalls, 0);
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].sessionId, 'ses-recent');
    assert.strictEqual(prompts[0].text, 'hello');
    assert.strictEqual(prompts[0].assistantId, 'persona-1');
    assert.strictEqual(prompts[0].modelOverride, undefined);
    assert.ok(prompts[0].logger);
    assert.deepStrictEqual(bindingStore.get('tool-bootstrap'), {
      anchor: 'tool-bootstrap',
      activeOpencodeSessionId: 'ses-recent',
      status: 'active',
    });
    assert.strictEqual(ownershipResolver.resolveAttachedAnchor('ses-recent'), 'tool-bootstrap');
    assert.deepStrictEqual(projected, []);
  });

  test('creates a new session only when no recent session is available', async () => {
    const prompts = [];
    let createCalls = 0;
    const hostSessionCreationPort = {
      async createSession() {
        createCalls += 1;
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
        hostModelCatalogPort: { async listModels() { return []; } },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: createCompletionPortSenderStub([]),
        }),
      }),
      hostPromptExecutionPort,
    });

    const result = await router.route({
      anchor: 'tool-bootstrap-empty',
      text: 'hello',
      logger: createLoggerStub(),
    });

    assert.deepStrictEqual(result, { kind: 'chat_forwarded', sessionId: 'ses-bootstrap' });
    assert.strictEqual(createCalls, 1);
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].sessionId, 'ses-bootstrap');
    assert.deepStrictEqual(bindingStore.get('tool-bootstrap-empty'), {
      anchor: 'tool-bootstrap-empty',
      activeOpencodeSessionId: 'ses-bootstrap',
      status: 'active',
    });
  });

  test('slash new rotates ownership and emits canonical synthetic assistant reply plus tool_done', async () => {
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
      sender: createCompletionPortSenderStub(projected),
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
    assert.strictEqual(projected.length, 5);
    assertSyntheticAssistantReply(projected, 0, 'tool-1', '已切换到新会话 `ses-new` ses-new');
    assert.deepStrictEqual(projected[4], {
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
          sender: createCompletionPortSenderStub(projected),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-new-fail', text: 'hello', logger: createLoggerStub() });
    const result = await router.route({ anchor: 'tool-new-fail', text: '/new', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assertSyntheticAssistantReply(projected, 0, 'tool-new-fail', '新建会话失败 当前宿主不可用');
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
        if (Object.keys(scope).length === 0) {
          return [
            { id: 'ses-bootstrap', title: '当前会话', projectID: 'proj-1', workspaceID: 'ws-1', directory: '/tmp/proj-1' },
          ];
        }
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
          sender: createCompletionPortSenderStub(projected),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-sessions', text: 'hello', logger: createLoggerStub() });
    const result = await router.route({ anchor: 'tool-sessions', text: '/sessions', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assertSyntheticAssistantReply(
      projected,
      0,
      'tool-sessions',
      '可切换会话列表\n\n- `ses-bootstrap` 当前会话（当前）\n- `ses-2` 第二个会话',
    );
  });

  test('reused recent session establishes scope for subsequent sessions listing', async () => {
    const projected = [];
    let listCalls = 0;
    const hostSessionCreationPort = {
      async createSession() {
        throw new Error('createSession should not be called');
      },
    };
    const hostSessionQueryPort = {
      async getSession() {
        throw new Error('getSession should not be called for reused recent bootstrap');
      },
      async listSessions(scope) {
        listCalls += 1;
        if (listCalls === 1) {
          assert.deepStrictEqual(scope, {});
          return [
            { id: 'ses-recent', title: '最近会话', projectID: 'proj-1', workspaceID: 'ws-1', directory: '/tmp/proj-1' },
          ];
        }
        assert.deepStrictEqual(scope, {
          projectID: 'proj-1',
          workspaceID: 'ws-1',
          directory: '/tmp/proj-1',
        });
        return [
          { id: 'ses-recent', title: '最近会话', projectID: 'proj-1', workspaceID: 'ws-1', directory: '/tmp/proj-1' },
          { id: 'ses-2', title: '第二个会话', projectID: 'proj-1', workspaceID: 'ws-1', directory: '/tmp/proj-1' },
        ];
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
          sender: createCompletionPortSenderStub(projected),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    const result = await router.route({ anchor: 'tool-recent-scope', text: '/sessions', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assert.strictEqual(listCalls, 2);
    assert.deepStrictEqual(bindingStore.get('tool-recent-scope'), {
      anchor: 'tool-recent-scope',
      activeOpencodeSessionId: 'ses-recent',
      status: 'active',
    });
    assertSyntheticAssistantReply(
      projected,
      0,
      'tool-recent-scope',
      '可切换会话列表\n\n- `ses-recent` 最近会话（当前）\n- `ses-2` 第二个会话',
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
          sender: createCompletionPortSenderStub(projected),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-switch', text: 'hello', logger: createLoggerStub() });
    const result = await router.route({ anchor: 'tool-switch', text: '/session ses-2', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assertSyntheticAssistantReply(projected, 0, 'tool-switch', '切换会话失败, 目标会话不在当前 project/workspace 可切换范围内');
    assert.deepStrictEqual(bindingStore.get('tool-switch'), {
      anchor: 'tool-switch',
      activeOpencodeSessionId: 'ses-bootstrap',
      status: 'active',
    });
  });

  test('slash session keeps committed binding when tool_done delivery fails and does not emit tool_error', async () => {
    const projected = [];
    const prompts = [];
    const { logger, errors } = createRecordingLogger();
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
          title: sessionId === 'ses-2' ? '切换后会话' : 'bootstrap',
          projectID: 'proj-1',
          workspaceID: 'ws-1',
          directory: '/tmp/proj-1',
        };
      },
      async listSessions() {
        return [
          { id: 'ses-bootstrap', title: 'bootstrap', projectID: 'proj-1', workspaceID: 'ws-1', directory: '/tmp/proj-1' },
          { id: 'ses-2', title: '切换后会话', projectID: 'proj-1', workspaceID: 'ws-1', directory: '/tmp/proj-1' },
        ];
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
    const router = new BindingAwareChatRouter({
      contextResolver,
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCommandOrchestrator: new DefaultSlashCommandOrchestrator({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
        hostPromptExecutionPort: {
          async prompt(input) {
            prompts.push(input);
          },
        },
        hostModelCatalogPort: { async listModels() { return []; } },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: createCompletionPortSenderStub(projected, { failAtCall: 5 }),
        }),
      }),
      hostPromptExecutionPort: {
        async prompt(input) {
          prompts.push(input);
        },
      },
    });

    await router.route({ anchor: 'tool-switch-tool-done-fail', text: 'hello', logger });
    const result = await router.route({
      anchor: 'tool-switch-tool-done-fail',
      text: '/session ses-2',
      logger,
    });
    await router.route({
      anchor: 'tool-switch-tool-done-fail',
      text: 'after switch',
      logger,
    });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assert.deepStrictEqual(bindingStore.get('tool-switch-tool-done-fail'), {
      anchor: 'tool-switch-tool-done-fail',
      activeOpencodeSessionId: 'ses-2',
      status: 'active',
    });
    assert.strictEqual(projected.some((message) => message.type === 'tool_error'), false);
    assertSyntheticAssistantReply(projected, 0, 'tool-switch-tool-done-fail', '已切换会话 `ses-2` 切换后会话');
    assert.deepStrictEqual(projected[4], {
      type: 'tool_done',
      toolSessionId: 'tool-switch-tool-done-fail',
    });
    assert.deepStrictEqual(errors, [
      {
        event: 'runtime.slash.synthetic_reply_delivery_failed',
        fields: {
          anchor: 'tool-switch-tool-done-fail',
          toolSessionId: 'tool-switch-tool-done-fail',
          command: 'session',
          failureStage: 'tool_done',
          messageType: 'tool_done',
          completionSource: 'slash_control_plane',
          completionKind: 'success',
        },
      },
    ]);
    assert.deepStrictEqual(prompts, [
      {
        sessionId: 'ses-bootstrap',
        text: 'hello',
        assistantId: undefined,
        modelOverride: undefined,
        logger: prompts[0].logger,
      },
      {
        sessionId: 'ses-2',
        text: 'after switch',
        assistantId: undefined,
        modelOverride: undefined,
        logger: prompts[1].logger,
      },
    ]);
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
      calls: 0,
      async listSessions() {
        this.calls += 1;
        if (this.calls === 1) {
          return [
            { id: 'ses-bootstrap', title: 'bootstrap', projectID: 'proj-1', workspaceID: 'ws-1', directory: '/tmp/proj-1' },
          ];
        }
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
          sender: createCompletionPortSenderStub(projected),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-sessions-fail', text: 'hello', logger: createLoggerStub() });
    const result = await router.route({ anchor: 'tool-sessions-fail', text: '/sessions', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'slash_completed' });
    assertSyntheticAssistantReply(projected, 0, 'tool-sessions-fail', '查询会话列表失败, 当前宿主不可用');
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
          sender: createCompletionPortSenderStub(projected),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-context-fail', text: 'hello', logger: createLoggerStub() });
    await assert.rejects(
      router.route({ anchor: 'tool-context-fail', text: '/sessions', logger: createLoggerStub() }),
      /slash_command\.failure_handled/u,
    );

    assert.strictEqual(projected.length, 4);
    assertSyntheticAssistantReply(projected, 0, 'tool-context-fail', '查询会话列表失败, 当前没有可用会话');
  });

  test('matched slash context failure still throws handled error when failure reply sender throws', async () => {
    const { logger, errors } = createRecordingLogger();
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
          throw new Error('session missing');
        }
        return { id: sessionId, title: sessionId, directory: `/tmp/${sessionId}` };
      },
      async listSessions() {
        return [];
      },
    };
    const modelStore = new InMemorySessionModelOverrideStore();
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const router = new BindingAwareChatRouter({
      contextResolver: new ResolveSlashCommandContextUseCase({
        bindingStore,
        ownershipResolver,
        modelOverrideStore: modelStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
      }),
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
          sender: async () => {
            throw new Error('send exploded');
          },
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-context-send-throw', text: 'hello', logger });

    await assert.rejects(
      router.route({ anchor: 'tool-context-send-throw', text: '/sessions', logger }),
      /slash_command\.failure_handled/u,
    );
    assert.deepStrictEqual(errors, [
      {
        event: 'runtime.slash.synthetic_reply_delivery_failed',
        fields: {
          anchor: 'tool-context-send-throw',
          toolSessionId: 'tool-context-send-throw',
          command: 'sessions',
          failureStage: 'message.updated',
          messageType: 'message.updated',
          completionSource: 'slash_control_plane',
          completionKind: 'failure',
        },
      },
    ]);
  });

  test('reuses the most recent session when resolving an invalid binding on the next request', async () => {
    const prompts = [];
    let listCalls = 0;
    const hostSessionCreationPort = {
      async createSession() {
        throw new Error('createSession should not be called');
      },
    };
    const hostSessionQueryPort = {
      async getSession(sessionId) {
        return { id: sessionId, title: sessionId, directory: '/tmp/recovered' };
      },
      async listSessions(scope) {
        listCalls += 1;
        assert.deepStrictEqual(scope, {});
        return [{ id: 'ses-recovered', title: '恢复会话', directory: '/tmp/recovered' }];
      },
    };
    const projected = [];
    const modelStore = new InMemorySessionModelOverrideStore();
    const bindingStore = new InMemoryToolSessionBindingStore();
    bindingStore.bind('tool-recover', 'ses-old');
    bindingStore.invalidate('tool-recover');
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    ownershipResolver.attach('ses-old', 'tool-recover');
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
        hostPromptExecutionPort: {
          async prompt(input) {
            prompts.push(input);
          },
        },
        hostModelCatalogPort: { async listModels() { return []; } },
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        completionPort: new RuntimeSlashCommandCompletionPort({
          projector: new MemoryGatewayEnvelopeProjector(),
          sender: createCompletionPortSenderStub(projected),
        }),
      }),
      hostPromptExecutionPort: {
        async prompt(input) {
          prompts.push(input);
        },
      },
    });

    const result = await router.route({ anchor: 'tool-recover', text: 'hello after recover', logger: createLoggerStub() });

    assert.deepStrictEqual(result, { kind: 'chat_forwarded', sessionId: 'ses-recovered' });
    assert.strictEqual(listCalls, 1);
    assert.deepStrictEqual(bindingStore.get('tool-recover'), {
      anchor: 'tool-recover',
      activeOpencodeSessionId: 'ses-recovered',
      status: 'active',
    });
    assert.strictEqual(ownershipResolver.resolveAttachedAnchor('ses-old'), undefined);
    assert.strictEqual(ownershipResolver.resolveAttachedAnchor('ses-recovered'), 'tool-recover');
    assert.deepStrictEqual(prompts, [
      {
        sessionId: 'ses-recovered',
        text: 'hello after recover',
        assistantId: undefined,
        modelOverride: undefined,
        logger: prompts[0].logger,
      },
    ]);
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
          sender: createCompletionPortSenderStub(projected),
        }),
      }),
      hostPromptExecutionPort,
    });

    await router.route({ anchor: 'tool-model', text: 'hello', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-model', text: '/model openai/gpt-5.4', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-model', text: 'first prompt', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-model', text: '/session ses-2', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-model', text: 'second prompt', logger: createLoggerStub() });

    assertSyntheticAssistantReply(projected, 0, 'tool-model', '后续请求将使用该模型 openai/gpt-5.4');
    assertSyntheticAssistantReply(projected, 5, 'tool-model', '已切换会话 `ses-2` 会话二');
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
          sender: createCompletionPortSenderStub(projected),
        }),
      }),
      hostPromptExecutionPort: { async prompt() {} },
    });

    await router.route({ anchor: 'tool-models', text: 'hello', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-models', text: '/models', logger: createLoggerStub() });
    await router.route({ anchor: 'tool-models', text: '/model openai/not-exists', logger: createLoggerStub() });

    assertSyntheticAssistantReply(
      projected,
      0,
      'tool-models',
      '可用模型列表\n\n- `openai/gpt-5.4`\n- `anthropic/claude-sonnet-4`',
    );
    assertSyntheticAssistantReply(projected, 5, 'tool-models', '设置模型失败,目标模型不存在或当前宿主不可用');
  });
});
