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
    scope: { directory: '/workspace/created' },
    bootstrapSource: 'bootstrap_created',
  });
  assert.deepEqual(attachmentCalls, [{ toolSessionId: 'anchor-created-formal', sessionId: 'ses-created-formal' }]);
});

test('EntryAwareChatSessionResolver reuses visible session for the same business entry only', async () => {
  const modelOverrideStore = new InMemorySessionModelOverrideStore();
  const switchCalls = [];
  const createCalls = [];
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
  });

  assert.deepEqual(reused, {
    opencodeSessionId: 'ses-group-a',
    scope: { directory: '/workspace/a' },
    modelOverride: undefined,
    bootstrapSource: 'bootstrap_reused_recent_session',
  });
  assert.deepEqual(created, {
    opencodeSessionId: 'ses-created-b',
    scope: { directory: '/workspace/b' },
    modelOverride: undefined,
    bootstrapSource: 'bootstrap_created',
  });
  assert.deepEqual(switchCalls, [{ toolSessionId: 'tool-a', sessionId: 'ses-group-a' }]);
  assert.equal(createCalls[0].toolSessionId, 'tool-b');
  assert.equal(createCalls[0].entryKey.businessSessionId, 'group-b');
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

test('EntryAwareChatSessionResolver clears anchor-only state after first legal chat bootstrap', async () => {
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

  await resolver.resolve({
    message: {
      traceId: 'trace-anchor-only',
      runId: 'run-anchor-only',
      toolSessionId: 'tool-anchor-only',
      text: 'hello',
      context: {
        imGroupId: 'group-a',
      },
    },
  });

  assert.equal(await runtimeAnchorRepository.isAnchorOnly('tool-anchor-only'), false);
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

test('SdkChatPreprocessor applies request scoped slash policy after entry context resolution', async () => {
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
  });

  assert.equal(result.kind, 'synthetic_run');
});

test('SdkChatPreprocessor passes effective directory to formal normal chat resolver', async () => {
  const resolverCalls = [];
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
  });

  assert.equal(result.kind, 'normal_chat');
  assert.equal(resolverCalls[0].directory, '/workspace/formal-chat');
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

  port.invalidateAfterFailure('anchor-5', {
    errorEvidence: {
      sourceOperation: 'session.prompt',
      sourceErrorCode: 'session_not_found',
    },
  });

  assert.equal(bindingStore.get('anchor-5')?.status, 'invalid');
  assert.equal(ownershipResolver.resolveAttachedAnchor('ses-5'), undefined);

  bindingStore.bind('anchor-6', 'ses-6');
  ownershipResolver.attach('ses-6', 'anchor-6');
  port.invalidateAfterFailure('anchor-6', {
    errorEvidence: {
      sourceOperation: 'session.prompt',
      sourceErrorCode: 'provider_unavailable',
    },
  });
  assert.equal(bindingStore.get('anchor-6')?.status, 'active');
  assert.equal(ownershipResolver.resolveAttachedAnchor('ses-6'), 'anchor-6');
});
