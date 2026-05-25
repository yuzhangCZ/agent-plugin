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
  SdkSlashExecutionUseCase,
  StaticSlashCapabilityProvider,
} from '../../src/runtime/sdk/SdkChatControlPlane.ts';

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
    policy.decide({
      traceId: 'trace-2',
      runId: 'run-2',
      toolSessionId: 'anchor-2',
      text: '@bot /sessions',
      context: { imGroupId: 'group-1' },
    }),
    {
      kind: 'slash',
      descriptor: { kind: 'sessions' },
      disabledInEntry: true,
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
