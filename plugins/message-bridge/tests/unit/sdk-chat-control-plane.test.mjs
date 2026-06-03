import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryOpencodeSessionOwnershipResolver,
  InMemorySessionModelOverrideStore,
  InMemoryToolSessionBindingStore,
  SimpleSlashCommandParser,
} from '../../src/adapter/index.ts';
import { DefaultSlashCommandReplyPresenter, SlashCommandExecutor } from '../../src/usecase/index.ts';
import {
  ChatEntryPolicy,
  DefaultChatExecutionContextResolver,
  DefaultExecutionSessionInvalidationPort,
  SdkChatPreprocessor,
  SdkSlashExecutionUseCase,
  StaticSlashCapabilityProvider,
} from '../../src/runtime/sdk/SdkChatControlPlane.ts';
import {
  BusinessEntryContextResolver,
  DefaultBusinessEntryKeyResolver,
  DefaultBusinessEntryPolicyResolver,
  EntryAwareChatSessionResolver,
  RuntimeAnchorRegistry,
} from '../../src/runtime/sdk/session-isolation/index.ts';

function createLogger() {
  const noop = () => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => createLogger(),
    getTraceId: () => 'trace-test',
  };
}

function createCapturingLogger(entries) {
  const write = (level) => (message, extra) => {
    entries.push({ level, message, extra });
  };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => createCapturingLogger(entries),
    getTraceId: () => 'trace-test',
  };
}

async function collect(asyncIterable) {
  const items = [];
  for await (const item of asyncIterable) {
    items.push(item);
  }
  return items;
}

test('ChatEntryPolicy denies suppressReply before slash parse', () => {
  const policy = new ChatEntryPolicy({
    slashCommandParser: new SimpleSlashCommandParser(),
    slashCapabilityProvider: new StaticSlashCapabilityProvider(),
  });

  assert.deepEqual(
    policy.decide({
      traceId: 'trace-1',
      runId: 'run-1',
      toolSessionId: 'anchor-1',
      text: '/sessions',
      context: { suppressReply: true },
    }),
    {
      kind: 'deny',
      text: '本机器人不处理群聊消息，请勿在群内@提问',
    },
  );
});

test('ChatEntryPolicy disables group-only forbidden slash commands', () => {
  const policy = new ChatEntryPolicy({
    slashCommandParser: new SimpleSlashCommandParser(),
    slashCapabilityProvider: new StaticSlashCapabilityProvider(),
  });

  assert.deepEqual(
    policy.decide(
      {
        traceId: 'trace-2',
        runId: 'run-2',
        toolSessionId: 'anchor-2',
        text: '@bot /sessions',
        context: { imGroupId: 'group-1' },
      },
      {
        entryKey: 'im:group:group-1',
        controlled: true,
        allowOpencodeNativeSessions: false,
        allowedSlashCommands: ['new'],
      },
    ),
    {
      kind: 'slash',
      descriptor: { kind: 'sessions' },
      disabledInEntry: true,
    },
  );
});

test('ChatEntryPolicy allows group slash commands when policy includes command', () => {
  const policy = new ChatEntryPolicy({
    slashCommandParser: new SimpleSlashCommandParser(),
    slashCapabilityProvider: new StaticSlashCapabilityProvider(),
  });

  assert.deepEqual(
    policy.decide(
      {
        traceId: 'trace-group-allow',
        runId: 'run-group-allow',
        toolSessionId: 'anchor-group-allow',
        text: '@bot /sessions',
        context: { imGroupId: 'group-1' },
      },
      {
        entryKey: 'im:group:group-1',
        controlled: true,
        allowOpencodeNativeSessions: false,
        allowedSlashCommands: ['new', 'sessions', 'session', 'models', 'model'],
      },
    ),
    {
      kind: 'slash',
      descriptor: { kind: 'sessions' },
      command: { kind: 'sessions' },
    },
  );
});

test('SdkSlashExecutionUseCase returns synthetic success run for /model and preserves legacy text', async () => {
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  const modelOverrideStore = new InMemorySessionModelOverrideStore();
  bindingStore.bind('anchor-3', 'ses-3');
  ownershipResolver.attach('ses-3', 'anchor-3');

  const contextResolver = new DefaultChatExecutionContextResolver({
    bindingStore,
    ownershipResolver,
    modelOverrideStore,
    hostSessionCreationPort: { createSession: async () => ({ id: 'unexpected-create' }) },
    hostSessionQueryPort: {
      getSession: async () => ({ id: 'ses-3' }),
      listSessions: async () => [{ id: 'ses-3' }],
    },
  });
  const usecase = new SdkSlashExecutionUseCase({
    slashCommandExecutor: new SlashCommandExecutor({
      bindingStore,
      ownershipResolver,
      modelOverrideStore,
      hostSessionCreationPort: { createSession: async () => ({ id: 'unexpected-create' }) },
      hostSessionQueryPort: {
        getSession: async () => ({ id: 'ses-3' }),
        listSessions: async () => [{ id: 'ses-3' }],
      },
      hostModelCatalogPort: {
        listModels: async () => [{ providerId: 'openai', modelId: 'gpt-5.4' }],
      },
    }),
    replyPresenter: new DefaultSlashCommandReplyPresenter(),
    contextResolver,
  });

  const run = await usecase.execute({
    anchor: 'anchor-3',
    descriptor: { kind: 'model' },
    command: { kind: 'model', providerId: 'openai', modelId: 'gpt-5.4' },
    logger: createLogger(),
  });

  const facts = [];
  for await (const fact of run.facts) {
    facts.push(fact);
  }
  assert.deepEqual(facts.map((fact) => fact.type), ['message.start', 'text.delta', 'text.done', 'message.done']);
  assert.equal(facts[1].content, '后续请求将使用该模型 openai/gpt-5.4');
  assert.equal(facts[2].content, '后续请求将使用该模型 openai/gpt-5.4');
  assert.deepEqual(await run.result(), { outcome: 'completed' });
});

test('SdkSlashExecutionUseCase routes /sessions through session-isolation executor when entry context exists', async () => {
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  const modelOverrideStore = new InMemorySessionModelOverrideStore();
  let formalExecutorInput;

  const usecase = new SdkSlashExecutionUseCase({
    slashCommandExecutor: new SlashCommandExecutor({
      bindingStore,
      ownershipResolver,
      modelOverrideStore,
      hostSessionCreationPort: { createSession: async () => ({ id: 'unexpected-create' }) },
      hostSessionQueryPort: {
        getSession: async () => ({ id: 'unexpected-get' }),
        listSessions: async () => {
          throw new Error('legacy slash sessions should not be used');
        },
      },
      hostModelCatalogPort: {
        listModels: async () => [],
      },
    }),
    sessionIsolationSlashCommandExecutor: {
      execute: async (input) => {
        formalExecutorInput = input;
        return {
          kind: 'sessions',
          activeSessionId: 'ses-formal',
          sessions: [{ id: 'ses-formal', title: 'formal session' }],
        };
      },
    },
    replyPresenter: new DefaultSlashCommandReplyPresenter(),
    contextResolver: {
      resolveForChat: async () => {
        throw new Error('legacy slash context resolver should not be used');
      },
      resolveForControlAction: async () => ({ opencodeSessionId: 'unexpected-control' }),
    },
  });

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
  const run = await usecase.execute({
    anchor: 'anchor-formal-sessions',
    descriptor: { kind: 'sessions' },
    command: { kind: 'sessions' },
    ensuredContext: {
      opencodeSessionId: 'ses-formal',
      session: { id: 'ses-formal', title: 'formal session' },
      bootstrapSource: 'existing_binding',
    },
    entryContext,
    directory: '/workspace/formal',
    logger: createLogger(),
  });

  const facts = [];
  for await (const fact of run.facts) {
    facts.push(fact);
  }

  assert.equal(facts[1].content.includes('formal session'), true);
  assert.deepEqual(formalExecutorInput, {
    command: { kind: 'sessions' },
    anchor: 'anchor-formal-sessions',
    ensuredContext: {
      opencodeSessionId: 'ses-formal',
      session: { id: 'ses-formal', title: 'formal session' },
      bootstrapSource: 'existing_binding',
    },
    entryContext,
    directory: '/workspace/formal',
  });
});

test('SdkSlashExecutionUseCase still lets /new create a new session after ensure', async () => {
  let legacyCreateCalls = 0;
  const usecase = new SdkSlashExecutionUseCase({
    slashCommandExecutor: new SlashCommandExecutor({
      bindingStore: new InMemoryToolSessionBindingStore(),
      ownershipResolver: new InMemoryOpencodeSessionOwnershipResolver(),
      modelOverrideStore: new InMemorySessionModelOverrideStore(),
      hostSessionCreationPort: {
        createSession: async () => {
          legacyCreateCalls += 1;
          return { id: 'unexpected-create' };
        },
      },
      hostSessionQueryPort: {
        getSession: async () => ({ id: 'unexpected-get' }),
        listSessions: async () => [],
      },
      hostModelCatalogPort: {
        listModels: async () => [],
      },
    }),
    replyPresenter: new DefaultSlashCommandReplyPresenter(),
    contextResolver: {
      resolveForChat: async () => {
        throw new Error('unexpected_context_resolve');
      },
      resolveForControlAction: async () => ({ opencodeSessionId: 'unexpected-control' }),
    },
  });

  const run = await usecase.execute({
    anchor: 'anchor-new',
    descriptor: { kind: 'new' },
    command: { kind: 'new' },
    ensuredContext: {
      opencodeSessionId: 'ses-ensured-new',
      session: { id: 'ses-ensured-new', title: 'ensured new', directory: '/workspace/new' },
      bootstrapSource: 'bootstrap_created',
    },
    logger: createLogger(),
  });

  const facts = await collect(run.facts);
  assert.equal(facts[1].content.includes('unexpected-create'), true);
  assert.equal(legacyCreateCalls, 1);
});

test('SdkChatPreprocessor keeps ensure side effects before denied slash response', async () => {
  const callOrder = [];
  const preprocessor = new SdkChatPreprocessor({
    chatEntryPolicy: new ChatEntryPolicy({
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCapabilityProvider: new StaticSlashCapabilityProvider(),
    }),
    slashExecutionUseCase: {
      execute: async (input) => {
        callOrder.push('slash');
        assert.equal(input.disabledInEntry, true);
        return {
          runId: 'synthetic-denied-slash',
          facts: (async function* () {})(),
          result: async () => ({ outcome: 'completed' }),
        };
      },
    },
    contextResolver: {
      resolveForChat: async () => {
        throw new Error('unexpected_context_resolve');
      },
      resolveForControlAction: async () => {
        throw new Error('unexpected_control_resolve');
      },
    },
    businessEntryContextResolver: new BusinessEntryContextResolver({
      businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
      businessEntryPolicyResolver: new DefaultBusinessEntryPolicyResolver(),
    }),
    normalChatSessionResolver: {
      resolve: async () => {
        callOrder.push('ensure');
        return {
          opencodeSessionId: 'ses-denied-before-slash',
          session: { id: 'ses-denied-before-slash' },
          bootstrapSource: 'bootstrap_created',
        };
      },
    },
  });

  const result = await preprocessor.preprocess({
    traceId: 'trace-denied-slash-after-ensure',
    runId: 'run-denied-slash-after-ensure',
    toolSessionId: 'tool-denied-slash-after-ensure',
    text: '/sessions',
    extParameters: {
      platformExtParam: {
        businessSessionDomain: 'im',
        businessSessionType: 'group',
        businessSessionId: 'group-a',
      },
    },
  });

  assert.equal(result.kind, 'synthetic_run');
  assert.deepEqual(callOrder, ['ensure', 'slash']);
});

test('SdkChatPreprocessor requires ensured real session before /models executes', async () => {
  const preprocessor = new SdkChatPreprocessor({
    chatEntryPolicy: new ChatEntryPolicy({
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCapabilityProvider: new StaticSlashCapabilityProvider(),
    }),
    slashExecutionUseCase: {
      execute: async () => {
        throw new Error('unexpected_slash_execute');
      },
    },
    contextResolver: {
      resolveForChat: async () => {
        throw new Error('unexpected_context_resolve');
      },
      resolveForControlAction: async () => {
        throw new Error('unexpected_control_resolve');
      },
    },
    businessEntryContextResolver: new BusinessEntryContextResolver({
      businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
      businessEntryPolicyResolver: new DefaultBusinessEntryPolicyResolver(),
    }),
    normalChatSessionResolver: {
      resolve: async (input) => {
        const error = new Error('business_entry_key_required');
        if (!input.entryContext) {
          throw error;
        }
        return {
          opencodeSessionId: 'ses-models',
          session: { id: 'ses-models' },
          bootstrapSource: 'existing_binding',
        };
      },
    },
  });

  await assert.rejects(
    () => preprocessor.preprocess({
      traceId: 'trace-models-requires-entry',
      runId: 'run-models-requires-entry',
      toolSessionId: 'tool-models-requires-entry',
      text: '/models',
    }),
    /business_entry_key_required/,
  );
});

test('DefaultChatExecutionContextResolver carries session-scoped model override and self-heals invalid binding', async () => {
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  const modelOverrideStore = new InMemorySessionModelOverrideStore();
  bindingStore.bind('anchor-4', 'ses-stale');
  ownershipResolver.attach('ses-stale', 'anchor-4');
  modelOverrideStore.set('ses-fresh', { providerId: 'openai', modelId: 'gpt-5.4' });

  const resolver = new DefaultChatExecutionContextResolver({
    bindingStore,
    ownershipResolver,
    modelOverrideStore,
    hostSessionCreationPort: { createSession: async () => ({ id: 'ses-created' }) },
    hostSessionQueryPort: {
      getSession: async (sessionId) => {
        if (sessionId === 'ses-stale') {
          const error = new Error('stale');
          Object.assign(error, {
            errorEvidence: { sourceOperation: 'session.get', sourceErrorCode: 'session_not_found' },
          });
          throw error;
        }
        return { id: sessionId };
      },
      listSessions: async () => [{ id: 'ses-fresh', directory: '/workspace/fresh' }],
    },
  });

  const resolved = await resolver.resolveForChat('anchor-4', undefined, createLogger());

  assert.deepEqual(resolved, {
    opencodeSessionId: 'ses-fresh',
    session: { id: 'ses-fresh', directory: '/workspace/fresh' },
    scope: { directory: '/workspace/fresh' },
    modelOverride: { providerId: 'openai', modelId: 'gpt-5.4' },
    bootstrapSource: 'bootstrap_reused_recent_session',
  });
  assert.deepEqual(bindingStore.get('anchor-4'), {
    anchor: 'anchor-4',
    activeOpencodeSessionId: 'ses-fresh',
    status: 'active',
  });
});

test('DefaultChatExecutionContextResolver delegates recent-session attachment to session-isolation port', async () => {
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  const modelOverrideStore = new InMemorySessionModelOverrideStore();
  const attachmentCalls = [];

  const resolver = new DefaultChatExecutionContextResolver({
    bindingStore,
    ownershipResolver,
    modelOverrideStore,
    hostSessionCreationPort: { createSession: async () => ({ id: 'unexpected-create' }) },
    hostSessionQueryPort: {
      getSession: async (sessionId) => ({ id: sessionId }),
      listSessions: async () => [{ id: 'ses-recent-formal', directory: '/workspace/formal' }],
    },
    sessionAttachmentPort: {
      switchAttachedSession: async (input) => {
        attachmentCalls.push(input);
        bindingStore.bind(input.toolSessionId, input.sessionId);
        ownershipResolver.attach(input.sessionId, input.toolSessionId);
        return { applied: true };
      },
    },
  });

  const resolved = await resolver.resolveForChat('anchor-formal', undefined, createLogger());

  assert.deepEqual(resolved, {
    opencodeSessionId: 'ses-recent-formal',
    session: { id: 'ses-recent-formal', directory: '/workspace/formal' },
    scope: { directory: '/workspace/formal' },
    modelOverride: undefined,
    bootstrapSource: 'bootstrap_reused_recent_session',
  });
  assert.deepEqual(attachmentCalls, [{ toolSessionId: 'anchor-formal', sessionId: 'ses-recent-formal' }]);
});

test('DefaultChatExecutionContextResolver delegates newly-created session attachment to session-isolation port', async () => {
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  const modelOverrideStore = new InMemorySessionModelOverrideStore();
  const attachmentCalls = [];

  const resolver = new DefaultChatExecutionContextResolver({
    bindingStore,
    ownershipResolver,
    modelOverrideStore,
    hostSessionCreationPort: { createSession: async () => ({ id: 'ses-created-formal', directory: '/workspace/created' }) },
    hostSessionQueryPort: {
      getSession: async (sessionId) => ({ id: sessionId }),
      listSessions: async () => [],
    },
    sessionAttachmentPort: {
      switchAttachedSession: async (input) => {
        attachmentCalls.push(input);
        bindingStore.bind(input.toolSessionId, input.sessionId);
        ownershipResolver.attach(input.sessionId, input.toolSessionId);
        return { applied: true };
      },
    },
  });

  const resolved = await resolver.resolveForChat('anchor-created-formal', undefined, createLogger());

  assert.deepEqual(resolved, {
    opencodeSessionId: 'ses-created-formal',
    session: { id: 'ses-created-formal', directory: '/workspace/created' },
    scope: { directory: '/workspace/created' },
    bootstrapSource: 'bootstrap_created',
  });
  assert.deepEqual(attachmentCalls, [{ toolSessionId: 'anchor-created-formal', sessionId: 'ses-created-formal' }]);
});

test('DefaultChatExecutionContextResolver delegates existing binding owner refresh to session-isolation port', async () => {
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  const modelOverrideStore = new InMemorySessionModelOverrideStore();
  const attachmentCalls = [];
  bindingStore.bind('anchor-existing-formal', 'ses-existing-formal');

  const resolver = new DefaultChatExecutionContextResolver({
    bindingStore,
    ownershipResolver,
    modelOverrideStore,
    hostSessionCreationPort: { createSession: async () => ({ id: 'unexpected-create' }) },
    hostSessionQueryPort: {
      getSession: async (sessionId) => ({ id: sessionId, directory: '/workspace/existing' }),
      listSessions: async () => {
        throw new Error('should not list sessions when binding is active');
      },
    },
    sessionAttachmentPort: {
      switchAttachedSession: async (input) => {
        attachmentCalls.push(input);
        return { applied: true };
      },
    },
  });

  const resolved = await resolver.resolveForChat('anchor-existing-formal', undefined, createLogger());

  assert.deepEqual(resolved, {
    opencodeSessionId: 'ses-existing-formal',
    session: { id: 'ses-existing-formal', directory: '/workspace/existing' },
    scope: { directory: '/workspace/existing' },
    modelOverride: undefined,
    bootstrapSource: 'existing_binding',
  });
  assert.deepEqual(attachmentCalls, [{ toolSessionId: 'anchor-existing-formal', sessionId: 'ses-existing-formal' }]);
  assert.equal(ownershipResolver.resolveAttachedAnchor('ses-existing-formal'), undefined);
});

test('EntryAwareChatSessionResolver reuses visible session for the same business entry only', async () => {
  const modelOverrideStore = new InMemorySessionModelOverrideStore();
  const switchCalls = [];
  const createCalls = [];
  const logs = [];
  const resolver = new EntryAwareChatSessionResolver({
    businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
    resolveEntrySessionContextUseCase: {
      execute: async (input) => {
        if (input.entryKey.businessSessionId === 'group-a') {
          return {
            toolSessionId: input.toolSessionId,
            visibleSessions: [{ id: 'ses-group-a', directory: '/workspace/a' }],
          };
        }
        return {
          toolSessionId: input.toolSessionId,
          visibleSessions: [],
        };
      },
    },
    switchAttachedSessionUseCase: {
      execute: async (input) => {
        switchCalls.push(input);
        return { applied: true };
      },
    },
    createOwnedSessionUseCase: {
      execute: async (input) => {
        createCalls.push(input);
        return { session: { id: 'ses-created-b', directory: '/workspace/b' } };
      },
    },
    runtimeAnchorRepository: new RuntimeAnchorRegistry(),
    modelOverrideStore,
  });

  const reused = await resolver.resolve({
    message: {
      traceId: 'trace-a',
      runId: 'run-a',
      toolSessionId: 'tool-a',
      text: 'hello',
      extParameters: {
        platformExtParam: {
          businessSessionDomain: 'im',
          businessSessionType: 'group',
          businessSessionId: 'group-a',
        },
      },
    },
    logger: createCapturingLogger(logs),
  });
  const created = await resolver.resolve({
    message: {
      traceId: 'trace-b',
      runId: 'run-b',
      toolSessionId: 'tool-b',
      text: 'hello',
      extParameters: {
        platformExtParam: {
          businessSessionDomain: 'im',
          businessSessionType: 'group',
          businessSessionId: 'group-b',
        },
      },
    },
    logger: createCapturingLogger(logs),
  });

  assert.deepEqual(reused, {
    opencodeSessionId: 'ses-group-a',
    session: { id: 'ses-group-a', directory: '/workspace/a' },
    scope: { directory: '/workspace/a' },
    modelOverride: undefined,
    bootstrapSource: 'bootstrap_reused_recent_session',
  });
  assert.deepEqual(created, {
    opencodeSessionId: 'ses-created-b',
    session: { id: 'ses-created-b', directory: '/workspace/b' },
    scope: { directory: '/workspace/b' },
    modelOverride: undefined,
    bootstrapSource: 'bootstrap_created',
  });
  assert.deepEqual(switchCalls, [{ toolSessionId: 'tool-a', sessionId: 'ses-group-a' }]);
  assert.equal(createCalls[0].toolSessionId, 'tool-b');
  assert.equal(createCalls[0].entryKey.businessSessionId, 'group-b');
  const reusedLog = logs.find((entry) => entry.message === 'sdk_chat_context.entry_reused_visible_session');
  const createdLog = logs.find((entry) => entry.message === 'sdk_chat_context.entry_created');
  assert.equal(logs.some((entry) => entry.message === 'sdk_chat_context.entry_existing_binding'), false);
  assert.equal(reusedLog.extra.entryKey, 'im:group:group-a');
  assert.deepEqual(reusedLog.extra.visibleSessionIds, ['ses-group-a']);
  assert.equal(createdLog.extra.entryKey, 'im:group:group-b');
  assert.deepEqual(createdLog.extra.visibleSessionIds, []);
});

test('EntryAwareChatSessionResolver logs existing binding separately from visible session reuse', async () => {
  const logs = [];
  const switchCalls = [];
  const resolver = new EntryAwareChatSessionResolver({
    businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
    resolveEntrySessionContextUseCase: {
      execute: async (input) => ({
        toolSessionId: input.toolSessionId,
        bindingSessionId: 'ses-bound',
        session: { id: 'ses-bound', directory: '/workspace/bound' },
        visibleSessions: [{ id: 'ses-bound', directory: '/workspace/bound' }],
      }),
    },
    switchAttachedSessionUseCase: {
      execute: async (input) => {
        switchCalls.push(input);
        return { applied: true };
      },
    },
    createOwnedSessionUseCase: {
      execute: async () => {
        throw new Error('should not create when binding already resolves');
      },
    },
    runtimeAnchorRepository: new RuntimeAnchorRegistry(),
    modelOverrideStore: new InMemorySessionModelOverrideStore(),
  });

  const resolved = await resolver.resolve({
    message: {
      traceId: 'trace-existing-binding',
      runId: 'run-existing-binding',
      toolSessionId: 'tool-existing-binding',
      text: 'hello',
      extParameters: {
        platformExtParam: {
          businessSessionDomain: 'im',
          businessSessionType: 'group',
          businessSessionId: 'group-existing',
        },
      },
    },
    logger: createCapturingLogger(logs),
  });

  assert.deepEqual(resolved, {
    opencodeSessionId: 'ses-bound',
    session: { id: 'ses-bound', directory: '/workspace/bound' },
    scope: { directory: '/workspace/bound' },
    modelOverride: undefined,
    bootstrapSource: 'existing_binding',
  });
  const existingBindingLog = logs.find((entry) => entry.message === 'sdk_chat_context.entry_existing_binding');
  assert.equal(existingBindingLog.extra.entryKey, 'im:group:group-existing');
  assert.deepEqual(existingBindingLog.extra.visibleSessionIds, ['ses-bound']);
  assert.equal(existingBindingLog.extra.bindingSessionId, 'ses-bound');
  assert.deepEqual(switchCalls, [{ toolSessionId: 'tool-existing-binding', sessionId: 'ses-bound' }]);
  assert.equal(logs.some((entry) => entry.message === 'sdk_chat_context.entry_reused_visible_session'), false);
});

test('EntryAwareChatSessionResolver keeps raw binding session id in logs when binding falls outside current visible scope', async () => {
  const logs = [];
  const resolver = new EntryAwareChatSessionResolver({
    businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
    resolveEntrySessionContextUseCase: {
      execute: async (input) => ({
        toolSessionId: input.toolSessionId,
        bindingSessionId: 'ses-stale-binding',
        visibleSessions: [{ id: 'ses-visible', directory: '/workspace/visible' }],
      }),
    },
    switchAttachedSessionUseCase: {
      execute: async () => ({ applied: true }),
    },
    createOwnedSessionUseCase: {
      execute: async () => {
        throw new Error('should not create when a visible session can be reused');
      },
    },
    runtimeAnchorRepository: new RuntimeAnchorRegistry(),
    modelOverrideStore: new InMemorySessionModelOverrideStore(),
  });

  await resolver.resolve({
    message: {
      traceId: 'trace-stale-binding',
      runId: 'run-stale-binding',
      toolSessionId: 'tool-stale-binding',
      text: 'hello',
      extParameters: {
        platformExtParam: {
          businessSessionDomain: 'im',
          businessSessionType: 'group',
          businessSessionId: 'group-stale',
        },
      },
    },
    logger: createCapturingLogger(logs),
  });

  const reusedLog = logs.find((entry) => entry.message === 'sdk_chat_context.entry_reused_visible_session');
  assert.equal(reusedLog.extra.bindingSessionId, 'ses-stale-binding');
});

test('EntryAwareChatSessionResolver creates a new host session for anchor-only input even when visible sessions exist', async () => {
  const runtimeAnchorRepository = new RuntimeAnchorRegistry();
  await runtimeAnchorRepository.createAnchorOnly({ toolSessionId: 'tool-anchor-only-create' });
  const switchCalls = [];
  const createCalls = [];
  const logs = [];
  const resolver = new EntryAwareChatSessionResolver({
    businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
    resolveEntrySessionContextUseCase: {
      execute: async (input) => ({
        toolSessionId: input.toolSessionId,
        visibleSessions: [{ id: 'ses-visible-existing', directory: '/workspace/existing' }],
      }),
    },
    switchAttachedSessionUseCase: {
      execute: async (input) => {
        switchCalls.push(input);
        return { applied: true };
      },
    },
    createOwnedSessionUseCase: {
      execute: async (input) => {
        createCalls.push(input);
        return { session: { id: 'ses-created-anchor-only', directory: '/workspace/new' } };
      },
    },
    runtimeAnchorRepository,
    modelOverrideStore: new InMemorySessionModelOverrideStore(),
  });

  const result = await resolver.resolve({
    message: {
      traceId: 'trace-anchor-only-create',
      runId: 'run-anchor-only-create',
      toolSessionId: 'tool-anchor-only-create',
      text: 'hello',
      extParameters: {
        platformExtParam: {
          businessSessionDomain: 'im',
          businessSessionType: 'group',
          businessSessionId: 'group-anchor',
        },
      },
    },
    logger: createCapturingLogger(logs),
  });

  assert.deepEqual(result, {
    opencodeSessionId: 'ses-created-anchor-only',
    session: { id: 'ses-created-anchor-only', directory: '/workspace/new' },
    scope: { directory: '/workspace/new' },
    modelOverride: undefined,
    bootstrapSource: 'bootstrap_created',
  });
  assert.deepEqual(createCalls.map((call) => call.toolSessionId), ['tool-anchor-only-create']);
  assert.deepEqual(switchCalls, []);
  assert.equal(await runtimeAnchorRepository.isAnchorOnly('tool-anchor-only-create'), false);
  const createdLog = logs.find((entry) => entry.message === 'sdk_chat_context.entry_created_from_anchor_only');
  assert.equal(createdLog.extra.entryKey, 'im:group:group-anchor');
  assert.deepEqual(createdLog.extra.visibleSessionIds, ['ses-visible-existing']);
});

test('SdkChatPreprocessor ensures real session before slash execution', async () => {
  const callOrder = [];
  const preprocessor = new SdkChatPreprocessor({
    chatEntryPolicy: new ChatEntryPolicy({
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCapabilityProvider: new StaticSlashCapabilityProvider(),
    }),
    slashExecutionUseCase: {
      execute: async (input) => {
        callOrder.push('slash');
        assert.equal(input.ensuredContext?.opencodeSessionId, 'ses-ensured-before-slash');
        return {
          runId: 'synthetic-test',
          facts: (async function* () {})(),
          result: async () => ({ outcome: 'completed' }),
        };
      },
    },
    contextResolver: {
      resolveForChat: async () => {
        throw new Error('unexpected_context_resolve');
      },
      resolveForControlAction: async () => {
        throw new Error('unexpected_control_resolve');
      },
    },
    businessEntryContextResolver: new BusinessEntryContextResolver({
      businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
      businessEntryPolicyResolver: new DefaultBusinessEntryPolicyResolver(),
    }),
    normalChatSessionResolver: {
      resolve: async () => {
        callOrder.push('ensure');
        return {
          opencodeSessionId: 'ses-ensured-before-slash',
          session: { id: 'ses-ensured-before-slash' },
          bootstrapSource: 'bootstrap_created',
        };
      },
    },
  });

  await preprocessor.preprocess({
    traceId: 'trace-ensure-before-slash',
    runId: 'run-ensure-before-slash',
    toolSessionId: 'tool-ensure-before-slash',
    text: '/sessions',
    extParameters: {
      platformExtParam: {
        businessSessionDomain: 'im',
        businessSessionType: 'direct',
        businessSessionId: 'user-a#bot-a',
      },
    },
  });

  assert.deepEqual(callOrder, ['ensure', 'slash']);
});

test('EntryAwareChatSessionResolver fails closed when chat business key cannot be completed', async () => {
  const resolver = new EntryAwareChatSessionResolver({
    businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
    resolveEntrySessionContextUseCase: {
      execute: async () => {
        throw new Error('unexpected_resolve_entry_context');
      },
    },
    switchAttachedSessionUseCase: {
      execute: async () => ({ applied: true }),
    },
    createOwnedSessionUseCase: {
      execute: async () => ({ session: { id: 'unexpected-create' } }),
    },
    runtimeAnchorRepository: new RuntimeAnchorRegistry(),
    modelOverrideStore: new InMemorySessionModelOverrideStore(),
  });

  await assert.rejects(
    () => resolver.resolve({
      message: {
        traceId: 'trace-missing',
        runId: 'run-missing',
        toolSessionId: 'tool-missing',
        text: 'hello',
        extParameters: {},
      },
    }),
    /business_entry_key_required/,
  );
});

test('EntryAwareChatSessionResolver keeps anchor-only state when chat businessSessionDomain is missing', async () => {
  const runtimeAnchorRepository = new RuntimeAnchorRegistry();
  await runtimeAnchorRepository.createAnchorOnly({ toolSessionId: 'tool-anchor-only' });
  const resolver = new EntryAwareChatSessionResolver({
    businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
    resolveEntrySessionContextUseCase: {
      execute: async (input) => ({
        toolSessionId: input.toolSessionId,
        visibleSessions: [],
      }),
    },
    switchAttachedSessionUseCase: {
      execute: async () => ({ applied: true }),
    },
    createOwnedSessionUseCase: {
      execute: async () => ({ session: { id: 'ses-first-legal-chat' } }),
    },
    runtimeAnchorRepository,
    modelOverrideStore: new InMemorySessionModelOverrideStore(),
  });

  await assert.rejects(
    () => resolver.resolve({
      message: {
        traceId: 'trace-anchor-only',
        runId: 'run-anchor-only',
        toolSessionId: 'tool-anchor-only',
        text: 'hello',
        context: {
          imGroupId: 'group-a',
        },
      },
    }),
    /business_entry_key_required/,
  );

  assert.equal(await runtimeAnchorRepository.isAnchorOnly('tool-anchor-only'), true);
});

test('SdkChatPreprocessor fails closed before slash execution when business entry is missing', async () => {
  let slashExecuted = false;
  const preprocessor = new SdkChatPreprocessor({
    chatEntryPolicy: new ChatEntryPolicy({
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCapabilityProvider: new StaticSlashCapabilityProvider(),
    }),
    slashExecutionUseCase: {
      execute: async () => {
        slashExecuted = true;
        throw new Error('unexpected_slash_execution');
      },
    },
    contextResolver: {
      resolveForChat: async () => {
        throw new Error('unexpected_context_resolve');
      },
      resolveForControlAction: async () => {
        throw new Error('unexpected_control_resolve');
      },
    },
    businessEntryContextResolver: new BusinessEntryContextResolver({
      businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
      businessEntryPolicyResolver: new DefaultBusinessEntryPolicyResolver(),
    }),
    normalChatSessionResolver: {
      resolve: async () => ({
        opencodeSessionId: 'ses-policy-slash',
        session: { id: 'ses-policy-slash' },
        bootstrapSource: 'existing_binding',
      }),
    },
  });

  await assert.rejects(
    () => preprocessor.preprocess({
      traceId: 'trace-missing-entry-slash',
      runId: 'run-missing-entry-slash',
      toolSessionId: 'tool-missing-entry-slash',
      text: '/sessions',
      extParameters: {},
    }),
    /business_entry_key_required/u,
  );
  assert.equal(slashExecuted, false);
});

test('SdkChatPreprocessor accepts miniapp chat when assistantAccount is missing but sendUserAccount is present', async () => {
  const preprocessor = new SdkChatPreprocessor({
    chatEntryPolicy: new ChatEntryPolicy({
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCapabilityProvider: new StaticSlashCapabilityProvider(),
    }),
    slashExecutionUseCase: {
      execute: async () => {
        throw new Error('unexpected_slash_execution');
      },
    },
    contextResolver: {
      resolveForChat: async () => {
        throw new Error('unexpected_context_resolve');
      },
      resolveForControlAction: async () => {
        throw new Error('unexpected_control_resolve');
      },
    },
    businessEntryContextResolver: new BusinessEntryContextResolver({
      businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
      businessEntryPolicyResolver: new DefaultBusinessEntryPolicyResolver(),
    }),
    normalChatSessionResolver: {
      resolve: async (input) => {
        assert.deepEqual(input.entryContext, {
          entryKey: {
            businessSessionDomain: 'miniapp',
            businessSessionType: 'direct',
            businessSessionId: 'miniapp-user-1',
          },
          policy: {
            entryKey: 'miniapp:direct:miniapp-user-1',
            controlled: false,
            allowOpencodeNativeSessions: true,
            allowedSlashCommands: ['new', 'sessions', 'session', 'models', 'model'],
            slashPolicySource: 'entry_template',
          },
        });
        return {
          opencodeSessionId: 'ses-miniapp-fallback',
          bootstrapSource: 'bootstrap_created',
        };
      },
    },
  });

  const result = await preprocessor.preprocess({
    traceId: 'trace-miniapp-fallback',
    runId: 'run-miniapp-fallback',
    toolSessionId: 'tool-miniapp-fallback',
    text: 'hello',
    context: {
      sendUserAccount: 'miniapp-user-1',
    },
    extParameters: {
      platformExtParam: {
        businessSessionDomain: 'miniapp',
      },
    },
  });

  assert.deepEqual(result, {
    kind: 'normal_chat',
    context: {
      opencodeSessionId: 'ses-miniapp-fallback',
      bootstrapSource: 'bootstrap_created',
    },
  });
});

test('SdkChatPreprocessor fails closed when domain is missing even if im legacy fields exist', async () => {
  const preprocessor = new SdkChatPreprocessor({
    chatEntryPolicy: new ChatEntryPolicy({
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCapabilityProvider: new StaticSlashCapabilityProvider(),
    }),
    slashExecutionUseCase: {
      execute: async () => {
        throw new Error('unexpected_slash_execution');
      },
    },
    contextResolver: {
      resolveForChat: async () => {
        throw new Error('unexpected_context_resolve');
      },
      resolveForControlAction: async () => {
        throw new Error('unexpected_control_resolve');
      },
    },
    businessEntryContextResolver: new BusinessEntryContextResolver({
      businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
      businessEntryPolicyResolver: new DefaultBusinessEntryPolicyResolver(),
    }),
    normalChatSessionResolver: {
      resolve: async () => ({
        opencodeSessionId: 'ses-policy-slash',
        session: { id: 'ses-policy-slash' },
        bootstrapSource: 'existing_binding',
      }),
    },
  });

  await assert.rejects(
    () => preprocessor.preprocess({
      traceId: 'trace-missing-domain-im',
      runId: 'run-missing-domain-im',
      toolSessionId: 'tool-missing-domain-im',
      text: 'hello',
      context: {
        imGroupId: 'group-a',
        assistantAccount: 'bot-1',
        sendUserAccount: 'user-1',
      },
      extParameters: {},
    }),
    /business_entry_key_required/u,
  );
});

test('SdkChatPreprocessor applies request scoped slash policy after entry context resolution', async () => {
  const logs = [];
  const preprocessor = new SdkChatPreprocessor({
    chatEntryPolicy: new ChatEntryPolicy({
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCapabilityProvider: new StaticSlashCapabilityProvider(),
    }),
    slashExecutionUseCase: {
      execute: async (input) => {
        assert.equal(input.disabledInEntry, true);
        return {
          runId: 'synthetic-disabled',
          facts: (async function* () {})(),
          result: async () => ({ outcome: 'completed' }),
        };
      },
    },
    contextResolver: {
      resolveForChat: async () => {
        throw new Error('unexpected_context_resolve');
      },
      resolveForControlAction: async () => {
        throw new Error('unexpected_control_resolve');
      },
    },
    businessEntryContextResolver: new BusinessEntryContextResolver({
      businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
      businessEntryPolicyResolver: new DefaultBusinessEntryPolicyResolver(),
    }),
    normalChatSessionResolver: {
      resolve: async () => ({
        opencodeSessionId: 'ses-policy-slash',
        session: { id: 'ses-policy-slash' },
        bootstrapSource: 'existing_binding',
      }),
    },
  });

  const result = await preprocessor.preprocess({
    traceId: 'trace-policy-slash',
    runId: 'run-policy-slash',
    toolSessionId: 'tool-policy-slash',
    text: '/sessions',
    extParameters: {
      platformExtParam: {
        businessSessionDomain: 'im',
        businessSessionType: 'group',
        businessSessionId: 'group-a',
        allowedSlashCommands: ['new'],
      },
    },
  }, createCapturingLogger(logs));

  assert.equal(result.kind, 'synthetic_run');
  assert.equal(
    logs.find((entry) => entry.message === 'sdk_chat_preprocessor.entry_policy_decision')?.level,
    'info',
  );
  assert.deepEqual(
    logs.find((entry) => entry.message === 'sdk_chat_preprocessor.entry_policy_decision')?.extra,
    {
      toolSessionId: 'tool-policy-slash',
      runId: 'run-policy-slash',
      policySource: 'request_payload',
      allowedSlashCommands: ['new'],
      decisionKind: 'slash',
      commandKind: 'sessions',
      disabledInEntry: true,
      invalid: false,
    },
  );
});

test('SdkChatPreprocessor records entry template slash policy source without request override', async () => {
  const logs = [];
  const preprocessor = new SdkChatPreprocessor({
    chatEntryPolicy: new ChatEntryPolicy({
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCapabilityProvider: new StaticSlashCapabilityProvider(),
    }),
    slashExecutionUseCase: {
      execute: async () => ({
        runId: 'synthetic-entry-template',
        facts: (async function* () {})(),
        result: async () => ({ outcome: 'completed' }),
      }),
    },
    contextResolver: {
      resolveForChat: async () => {
        throw new Error('unexpected_context_resolve');
      },
      resolveForControlAction: async () => {
        throw new Error('unexpected_control_resolve');
      },
    },
    businessEntryContextResolver: new BusinessEntryContextResolver({
      businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
      businessEntryPolicyResolver: new DefaultBusinessEntryPolicyResolver(),
    }),
    normalChatSessionResolver: {
      resolve: async () => ({
        opencodeSessionId: 'ses-entry-template',
        session: { id: 'ses-entry-template' },
        bootstrapSource: 'existing_binding',
      }),
    },
  });

  const result = await preprocessor.preprocess({
    traceId: 'trace-entry-template-slash',
    runId: 'run-entry-template-slash',
    toolSessionId: 'tool-entry-template-slash',
    text: '/models',
    context: {
      sendUserAccount: '1',
    },
    extParameters: {
      platformExtParam: {
        businessSessionDomain: 'miniapp',
        businessSessionType: 'direct',
        businessSessionId: null,
      },
    },
  }, createCapturingLogger(logs));

  assert.equal(result.kind, 'synthetic_run');
  assert.equal(
    logs.find((entry) => entry.message === 'sdk_chat_preprocessor.entry_policy_decision')?.level,
    'info',
  );
  assert.deepEqual(
    logs.find((entry) => entry.message === 'sdk_chat_preprocessor.entry_policy_decision')?.extra,
    {
      toolSessionId: 'tool-entry-template-slash',
      runId: 'run-entry-template-slash',
      policySource: 'entry_template',
      allowedSlashCommands: ['new', 'sessions', 'session', 'models', 'model'],
      decisionKind: 'slash',
      commandKind: 'models',
      disabledInEntry: false,
      invalid: false,
    },
  );
});

test('SdkChatPreprocessor records local default slash policy source without entry context', async () => {
  const logs = [];
  const preprocessor = new SdkChatPreprocessor({
    chatEntryPolicy: new ChatEntryPolicy({
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCapabilityProvider: new StaticSlashCapabilityProvider(),
    }),
    slashExecutionUseCase: {
      execute: async () => ({
        runId: 'synthetic-local-default',
        facts: (async function* () {})(),
        result: async () => ({ outcome: 'completed' }),
      }),
    },
    contextResolver: {
      resolveForChat: async () => ({
        opencodeSessionId: 'ses-local-default',
        session: { id: 'ses-local-default' },
        bootstrapSource: 'existing_binding',
      }),
      resolveForControlAction: async () => {
        throw new Error('unexpected_control_resolve');
      },
    },
  });

  const result = await preprocessor.preprocess({
    traceId: 'trace-local-default-slash',
    runId: 'run-local-default-slash',
    toolSessionId: 'tool-local-default-slash',
    text: '/sessions',
  }, createCapturingLogger(logs));

  assert.equal(result.kind, 'synthetic_run');
  assert.equal(
    logs.find((entry) => entry.message === 'sdk_chat_preprocessor.entry_policy_decision')?.level,
    'info',
  );
  assert.deepEqual(
    logs.find((entry) => entry.message === 'sdk_chat_preprocessor.entry_policy_decision')?.extra,
    {
      toolSessionId: 'tool-local-default-slash',
      runId: 'run-local-default-slash',
      policySource: 'local_default',
      allowedSlashCommands: undefined,
      decisionKind: 'slash',
      commandKind: 'sessions',
      disabledInEntry: false,
      invalid: false,
    },
  );
});

test('SdkChatPreprocessor passes effective directory to formal normal chat resolver', async () => {
  const resolverCalls = [];
  const logs = [];
  const preprocessor = new SdkChatPreprocessor({
    chatEntryPolicy: new ChatEntryPolicy({
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCapabilityProvider: new StaticSlashCapabilityProvider(),
    }),
    slashExecutionUseCase: {
      execute: async () => {
        throw new Error('unexpected_slash_execution');
      },
    },
    contextResolver: {
      resolveForChat: async () => {
        throw new Error('unexpected_context_resolve');
      },
      resolveForControlAction: async () => {
        throw new Error('unexpected_control_resolve');
      },
    },
    businessEntryContextResolver: new BusinessEntryContextResolver({
      businessEntryKeyResolver: new DefaultBusinessEntryKeyResolver(),
      businessEntryPolicyResolver: new DefaultBusinessEntryPolicyResolver(),
    }),
    effectiveDirectory: '/workspace/formal-chat',
    normalChatSessionResolver: {
      resolve: async (input) => {
        resolverCalls.push(input);
        return {
          opencodeSessionId: 'ses-formal-chat',
          scope: { directory: input.directory },
        };
      },
    },
  });

  const result = await preprocessor.preprocess({
    traceId: 'trace-formal-chat',
    runId: 'run-formal-chat',
    toolSessionId: 'tool-formal-chat',
    text: 'hello',
    extParameters: {
      platformExtParam: {
        businessSessionDomain: 'im',
        businessSessionType: 'group',
        businessSessionId: 'group-formal-chat',
      },
    },
  }, createCapturingLogger(logs));

  assert.equal(result.kind, 'normal_chat');
  assert.equal(resolverCalls[0].directory, '/workspace/formal-chat');
  assert.equal(
    logs.some((entry) => entry.message === 'sdk_chat_preprocessor.entry_policy_decision'),
    false,
  );
});

test('DefaultChatExecutionContextResolver allows stale real sessionId to keep acting as anchor after rebind', async () => {
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  const modelOverrideStore = new InMemorySessionModelOverrideStore();
  bindingStore.bind('ses-initial', 'ses-initial');
  ownershipResolver.attach('ses-initial', 'ses-initial');

  const resolver = new DefaultChatExecutionContextResolver({
    bindingStore,
    ownershipResolver,
    modelOverrideStore,
    hostSessionCreationPort: { createSession: async () => ({ id: 'ses-created' }) },
    hostSessionQueryPort: {
      getSession: async (sessionId) => {
        if (sessionId === 'ses-initial') {
          const error = new Error('stale');
          Object.assign(error, {
            errorEvidence: { sourceOperation: 'session.get', sourceErrorCode: 'session_not_found' },
          });
          throw error;
        }
        return { id: sessionId };
      },
      listSessions: async () => [{ id: 'ses-rebound', directory: '/workspace/rebound' }],
    },
  });

  const resolved = await resolver.resolveForChat('ses-initial', undefined, createLogger());

  assert.deepEqual(resolved, {
    opencodeSessionId: 'ses-rebound',
    session: { id: 'ses-rebound', directory: '/workspace/rebound' },
    scope: { directory: '/workspace/rebound' },
    modelOverride: undefined,
    bootstrapSource: 'bootstrap_reused_recent_session',
  });
  assert.deepEqual(bindingStore.get('ses-initial'), {
    anchor: 'ses-initial',
    activeOpencodeSessionId: 'ses-rebound',
    status: 'active',
  });
  assert.equal(ownershipResolver.resolveAttachedAnchor('ses-initial'), undefined);
  assert.equal(ownershipResolver.resolveAttachedAnchor('ses-rebound'), 'ses-initial');
});

test('DefaultExecutionSessionInvalidationPort only invalidates stale binding evidence', () => {
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  bindingStore.bind('anchor-5', 'ses-5');
  ownershipResolver.attach('ses-5', 'anchor-5');

  const port = new DefaultExecutionSessionInvalidationPort({
    bindingStore,
    ownershipResolver,
  });

  port.invalidateAfterFailure({
    conversationId: 'anchor-5',
    hostSessionId: 'ses-5',
    error: {
      errorEvidence: {
        sourceOperation: 'session.prompt',
        sourceErrorCode: 'session_not_found',
      },
    },
  });

  assert.equal(bindingStore.get('anchor-5')?.status, 'invalid');
  assert.equal(ownershipResolver.resolveAttachedAnchor('ses-5'), undefined);

  bindingStore.bind('anchor-6', 'ses-6');
  ownershipResolver.attach('ses-6', 'anchor-6');
  port.invalidateAfterFailure({
    conversationId: 'anchor-6',
    hostSessionId: 'ses-6',
    error: {
      errorEvidence: {
        sourceOperation: 'session.prompt',
        sourceErrorCode: 'provider_unavailable',
      },
    },
  });
  assert.equal(bindingStore.get('anchor-6')?.status, 'active');
  assert.equal(ownershipResolver.resolveAttachedAnchor('ses-6'), 'anchor-6');
});

test('DefaultExecutionSessionInvalidationPort does not invalidate binding switched to another host session', () => {
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  bindingStore.bind('conversation-a', 'host-old');
  ownershipResolver.attach('host-old', 'conversation-a');
  bindingStore.bind('conversation-a', 'host-new');
  ownershipResolver.detach('host-old');
  ownershipResolver.attach('host-new', 'conversation-a');

  const port = new DefaultExecutionSessionInvalidationPort({
    bindingStore,
    ownershipResolver,
  });

  port.invalidateAfterFailure({
    conversationId: 'conversation-a',
    hostSessionId: 'host-old',
    error: {
      errorEvidence: {
        sourceOperation: 'session.prompt',
        sourceErrorCode: 'session_not_found',
      },
    },
  });

  assert.equal(bindingStore.get('conversation-a')?.status, 'active');
  assert.equal(bindingStore.get('conversation-a')?.activeOpencodeSessionId, 'host-new');
  assert.equal(ownershipResolver.resolveAttachedAnchor('host-new'), 'conversation-a');
});
