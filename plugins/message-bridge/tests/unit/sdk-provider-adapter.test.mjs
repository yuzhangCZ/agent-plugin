import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EnvBridgeChannelAdapter,
  InMemoryOpencodeSessionOwnershipResolver,
  InMemorySessionModelOverrideStore,
  InMemoryToolSessionBindingStore,
  JsonAssiantDirectoryMappingAdapter,
  OpencodeSessionGatewayAdapter,
  SimpleSlashCommandParser,
} from '../../src/adapter/index.ts';
import { SubagentSessionMapper } from '../../src/session/SubagentSessionMapper.ts';
import {
  CreateSessionRequestNormalizer,
  CreateSessionUseCase,
  DefaultSlashCommandReplyPresenter,
  ResolveCreateSessionDirectoryUseCase,
  SlashCommandExecutor,
} from '../../src/usecase/index.ts';
import { OpenCodeProviderAdapter } from '../../src/runtime/sdk/OpenCodeProviderAdapter.ts';
import {
  ChatEntryPolicy,
  DefaultChatExecutionContextResolver,
  DefaultCreatedSessionBindingPort,
  DefaultEventAnchorResolver,
  DefaultExecutionSessionInvalidationPort,
  SdkChatPreprocessor,
  SdkSlashExecutionUseCase,
  StaticSlashCapabilityProvider,
} from '../../src/runtime/sdk/SdkChatControlPlane.ts';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createPromptResponse(overrides = {}) {
  return {
    data: {
      info: {
        id: 'msg-prompt-1',
        cost: 0.12,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 3,
          cache: {
            read: 0,
            write: 0,
          },
        },
        ...overrides.info,
      },
      parts: overrides.parts ?? [{ type: 'step-finish' }],
    },
  };
}

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

function createSdkClient(overrides = {}) {
  return {
    session: {
      create: async () => ({ data: { id: 'session-created-1' } }),
      get: async (input) => ({
        data: {
          id: input?.path?.id ?? input?.sessionID ?? 'session-1',
          directory: '/workspace/test',
        },
      }),
      list: async () => ({ data: [] }),
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      prompt: async () => createPromptResponse(),
      ...(overrides.session ?? {}),
    },
    config: {
      providers: async () => ({ data: [] }),
      ...(overrides.config ?? {}),
    },
    permission: {
      reply: async () => ({ data: true }),
      ...(overrides.permission ?? {}),
    },
    question: {
      reply: async () => ({ data: true }),
      ...(overrides.question ?? {}),
    },
  };
}

function createRawClient() {
  return {
    global: {
      health: async () => ({ healthy: true, version: '9.9.9' }),
    },
  };
}

async function collect(asyncIterable) {
  const items = [];
  for await (const item of asyncIterable) {
    items.push(item);
  }
  return items;
}

function createAdapter(overrides = {}) {
  const sdkClient = 'sdkClient' in overrides ? overrides.sdkClient : createSdkClient(overrides);
  const logger = overrides.logger ?? createLogger();
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  const modelOverrideStore = new InMemorySessionModelOverrideStore();
  const directoryMappingPort = new JsonAssiantDirectoryMappingAdapter(undefined, () => logger);
  const opencodeSessionGatewayAdapter = new OpencodeSessionGatewayAdapter(
    () => sdkClient,
    () => ({
      channel: overrides.gatewayChannel ?? 'openx',
      bridgeDirectoryConfigured: 'bridgeDirectory' in overrides ? Boolean(overrides.bridgeDirectory) : true,
    }),
  );
  const createSessionUseCase = new CreateSessionUseCase(
    new ResolveCreateSessionDirectoryUseCase(new EnvBridgeChannelAdapter(), directoryMappingPort, logger),
    opencodeSessionGatewayAdapter,
  );
  const createSessionRequestNormalizer = new CreateSessionRequestNormalizer();
  const hostSessionCreationPort = {
    createSession: async (input) => {
      const normalized = createSessionRequestNormalizer.fromChatContext({
        assistantId: input?.assistantId,
        imGroupId: input?.imGroupId,
      });
      const result = await createSessionUseCase.execute({
        ...normalized,
        effectiveDirectory: overrides.hostDirectory ?? '/workspace/test',
        directoryMappingEnabled: false,
      });
      if (!result.success || !result.data.sessionId) {
        const error = new Error(result.errorMessage ?? 'create_session_failed');
        Object.assign(error, { errorEvidence: result.errorEvidence });
        throw error;
      }
      return {
        id: result.data.sessionId,
        title: result.data.session.title,
        projectID: result.data.session.projectID,
        workspaceID: result.data.session.workspaceID,
        directory: result.data.session.directory,
      };
    },
  };
  const hostSessionQueryPort = {
    getSession: async (sessionId) => {
      if (!sdkClient) {
        throw new Error('runtime.sdk_client_unavailable');
      }
      try {
        const result = await sdkClient.session.get({ sessionID: sessionId });
        if (result?.error) {
          const error = new Error('session_not_found');
          Object.assign(error, {
            cause: result.error,
            errorEvidence: { sourceOperation: 'session.get', sourceErrorCode: 'session_not_found' },
          });
          throw error;
        }
        if (!result?.data?.id) {
          throw new Error(`Invalid session.get response shape: missing session id for ${sessionId}`);
        }
        return result.data;
      } catch (error) {
        if (error instanceof Error && (error.name === 'NotFoundError' || error.message === 'session_not_found')) {
          Object.assign(error, {
            errorEvidence: { sourceOperation: 'session.get', sourceErrorCode: 'session_not_found' },
          });
        }
        throw error;
      }
    },
    listSessions: async () => {
      if (!sdkClient) {
        throw new Error('runtime.sdk_client_unavailable');
      }
      const result = await sdkClient.session.list({});
      return Array.isArray(result?.data) ? result.data : [];
    },
  };
  const hostModelCatalogPort = {
    listModels: async () => {
      if (!sdkClient) {
        throw new Error('runtime.sdk_client_unavailable');
      }
      const result = await sdkClient.config.providers({});
      const providers = Array.isArray(result?.data?.providers) ? result.data.providers : Array.isArray(result?.data) ? result.data : [];
      return providers.flatMap((provider) => {
        const providerId = provider?.id ?? provider?.providerID ?? provider?.name;
        if (!providerId || !provider?.models) {
          return [];
        }
        return Object.values(provider.models).flatMap((model) => {
          const modelId = model?.id ?? model?.modelID ?? model?.name;
          return modelId ? [{ providerId, modelId, label: model?.label }] : [];
        });
      });
    },
  };
  const contextResolver = new DefaultChatExecutionContextResolver({
    bindingStore,
    ownershipResolver,
    modelOverrideStore,
    hostSessionCreationPort,
    hostSessionQueryPort,
  });
  const chatPreprocessor = new SdkChatPreprocessor({
    chatEntryPolicy: new ChatEntryPolicy({
      slashCommandParser: new SimpleSlashCommandParser(),
      slashCapabilityProvider: new StaticSlashCapabilityProvider(),
    }),
    slashExecutionUseCase: new SdkSlashExecutionUseCase({
      slashCommandExecutor: new SlashCommandExecutor({
        bindingStore,
        ownershipResolver,
        modelOverrideStore,
        hostSessionCreationPort,
        hostSessionQueryPort,
        hostModelCatalogPort,
      }),
      replyPresenter: new DefaultSlashCommandReplyPresenter(),
      contextResolver,
    }),
    contextResolver,
  });
  for (const [anchor, sessionId] of overrides.bindings ?? []) {
    bindingStore.bind(anchor, sessionId);
    ownershipResolver.attach(sessionId, anchor);
  }

  return new OpenCodeProviderAdapter({
    rawClient: createRawClient(),
    logger,
    createSessionUseCase,
    effectiveDirectory: overrides.hostDirectory ?? '/workspace/test',
    directoryMappingEnabled: false,
    opencodeSessionGatewayAdapter,
    chatPreprocessor,
    contextResolver,
    executionSessionInvalidationPort: new DefaultExecutionSessionInvalidationPort({
      bindingStore,
      ownershipResolver,
    }),
    eventAnchorResolver: new DefaultEventAnchorResolver({
      ownershipResolver,
    }),
    createdSessionBindingPort: new DefaultCreatedSessionBindingPort({
      bindingStore,
      ownershipResolver,
    }),
    subagentSessionMapper: new SubagentSessionMapper(() => sdkClient),
  });
}

test('provider adapter createSession returns real OpenCode sessionId and establishes identity binding', async () => {
  const adapter = createAdapter({
    session: {
      create: async () => ({
        data: {
          id: 'ses-created-identity',
          title: 'Identity Session',
          directory: '/workspace/identity',
        },
      }),
    },
  });

  const result = await adapter.createSession({ title: 'Identity Session' });

  assert.deepEqual(result, {
    toolSessionId: 'ses-created-identity',
    title: 'Identity Session',
  });
  assert.deepEqual(adapter.contextResolver.dependencies.bindingStore.get('ses-created-identity'), {
    anchor: 'ses-created-identity',
    activeOpencodeSessionId: 'ses-created-identity',
    status: 'active',
  });
  assert.equal(
    adapter.contextResolver.dependencies.ownershipResolver.resolveAttachedAnchor('ses-created-identity'),
    'ses-created-identity',
  );
});

test('provider adapter returns synthetic ProviderRun for suppressReply deny path', async () => {
  const adapter = createAdapter();

  const run = await adapter.runMessage({
    traceId: 'trace-1',
    runId: 'run-1',
    toolSessionId: 'tool-1',
    text: 'hello',
    context: {
      suppressReply: true,
    },
  });

  const facts = await collect(run.facts);
  assert.deepEqual(
    facts.map((fact) => fact.type),
    ['message.start', 'text.delta', 'text.done', 'message.done'],
  );
  assert.deepEqual(await run.result(), { outcome: 'completed' });
});

test('provider adapter returns synthetic ProviderRun for slash command without calling prompt', async () => {
  let promptCalled = false;
  const adapter = createAdapter({
    session: {
      prompt: async () => {
        promptCalled = true;
        return createPromptResponse();
      },
      list: async () => ({
        data: [{ id: 'ses-list-1', title: '会话一' }],
      }),
    },
  });

  const run = await adapter.runMessage({
    traceId: 'trace-slash',
    runId: 'run-slash',
    toolSessionId: 'anchor-slash',
    text: '/sessions',
  });

  const facts = await collect(run.facts);
  assert.strictEqual(promptCalled, false);
  assert.deepEqual(facts.map((fact) => fact.type), ['message.start', 'text.delta', 'text.done', 'message.done']);
  assert.match(facts[1].content, /可切换会话列表/);
  assert.match(facts[2].content, /可切换会话列表/);
  assert.deepEqual(await run.result(), { outcome: 'completed' });
});

test('provider adapter returns failed run when bound session.get proves stale session', async () => {
  let promptCalled = false;
  const adapter = createAdapter({
    bindings: [['tool-stale', 'tool-stale']],
    session: {
      get: async () => {
        const error = new Error('session missing');
        error.name = 'NotFoundError';
        throw error;
      },
      prompt: async () => {
        promptCalled = true;
        return createPromptResponse();
      },
    },
  });

  const run = await adapter.runMessage({
    traceId: 'trace-2',
    runId: 'run-2',
    toolSessionId: 'tool-stale',
    text: 'hello',
  });

  assert.strictEqual(promptCalled, false);
  assert.deepEqual(await collect(run.facts), []);
  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'session_not_found',
      message: 'Failed to send message: session missing',
    },
  });
});

test('provider adapter returns failed run when bound openx session is stale and prompt directory is omitted', async () => {
  let promptCalled = false;
  const adapter = createAdapter({
    bindings: [['tool-openx-stale', 'tool-openx-stale']],
    bridgeDirectory: undefined,
    gatewayChannel: 'openx',
    session: {
      get: async () => ({
        error: {
          name: 'NotFoundError',
          data: { message: 'Session not found: tool-openx-stale' },
        },
      }),
      prompt: async () => {
        promptCalled = true;
        return createPromptResponse();
      },
    },
  });

  const run = await adapter.runMessage({
    traceId: 'trace-openx-stale',
    runId: 'run-openx-stale',
    toolSessionId: 'tool-openx-stale',
    text: 'hello',
  });

  assert.strictEqual(promptCalled, false);
  assert.deepEqual(await collect(run.facts), []);
  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'session_not_found',
      message: 'Failed to send message: {"name":"NotFoundError","data":{"message":"Session not found: tool-openx-stale"}}',
    },
  });
});

test('provider adapter returns failed run when bound session.get returns invalid success payload', async () => {
  let promptCalled = false;
  const adapter = createAdapter({
    bindings: [['tool-invalid-shape', 'tool-invalid-shape']],
    session: {
      get: async () => ({
        data: {
          directory: '/workspace/test',
        },
      }),
      prompt: async () => {
        promptCalled = true;
        return createPromptResponse();
      },
    },
  });

  const run = await adapter.runMessage({
    traceId: 'trace-invalid-shape',
    runId: 'run-invalid-shape',
    toolSessionId: 'tool-invalid-shape',
    text: 'hello',
  });

  assert.strictEqual(promptCalled, false);
  assert.deepEqual(await collect(run.facts), []);
  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'provider_unavailable',
      message: 'Invalid session.get response shape: missing session id for tool-invalid-shape',
    },
  });
});

test('provider adapter returns failed run when sdk client is unavailable during preflight', async () => {
  const adapter = createAdapter({
    sdkClient: null,
    bindings: [['tool-no-client', 'tool-no-client']],
  });

  const run = await adapter.runMessage({
    traceId: 'trace-no-client',
    runId: 'run-no-client',
    toolSessionId: 'tool-no-client',
    text: 'hello',
  });

  assert.deepEqual(await collect(run.facts), []);
  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'provider_unavailable',
      message: 'runtime.sdk_client_unavailable',
    },
  });
});

test('provider adapter translates active run raw events into ProviderFacts and terminal result', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-stream', 'tool-stream']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-3',
    runId: 'run-3',
    toolSessionId: 'tool-stream',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-stream',
        id: 'msg-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-1',
        sessionID: 'tool-stream',
        messageID: 'msg-1',
        type: 'step-start',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: 'tool-stream',
      messageID: 'msg-1',
      partID: 'part-2',
      field: 'text',
      delta: 'he',
    },
  });
  await adapter.handleEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-2',
        sessionID: 'tool-stream',
        messageID: 'msg-1',
        type: 'text',
        text: 'hello',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-stream',
        id: 'msg-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
          completed: '2026-05-22T12:00:01.000Z',
        },
        finish: 'stop',
        tokens: {
          input: 12,
          output: 34,
        },
        cost: 0.56,
        reason: 'stop',
      },
    },
  });

  promptDeferred.resolve(createPromptResponse());
  const facts = await collect(run.facts);
  assert.deepEqual(
    facts.map((fact) => fact.type),
    ['message.start', 'text.delta', 'text.done', 'message.done'],
  );
  assert.deepEqual(facts.at(-1), {
    type: 'message.done',
    messageId: 'msg-1',
    reason: 'stop',
    tokens: {
      input: 12,
      output: 34,
    },
    cost: 0.56,
    raw: {
      info: {
        sessionID: 'tool-stream',
        id: 'msg-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
          completed: '2026-05-22T12:00:01.000Z',
        },
        finish: 'stop',
        tokens: {
          input: 12,
          output: 34,
        },
        cost: 0.56,
        reason: 'stop',
      },
    },
  });
  assert.deepEqual(await run.result(), { outcome: 'completed' });
});

test('provider adapter maps aborted prompt terminal to ProviderRun.result()', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-abort', 'tool-abort']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-abort',
    runId: 'run-abort',
    toolSessionId: 'tool-abort',
    text: 'hello',
  });

  promptDeferred.resolve(createPromptResponse({
    info: {
      error: {
        name: 'MessageAbortedError',
        data: {
          message: 'User aborted',
        },
      },
    },
  }));

  assert.deepEqual(await run.result(), { outcome: 'aborted' });
});

test('provider adapter no longer falls back to prompt message parts when raw lifecycle is absent', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-fallback', 'tool-fallback']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-fallback',
    runId: 'run-fallback',
    toolSessionId: 'tool-fallback',
    text: 'hello',
  });

  promptDeferred.resolve(createPromptResponse({
    info: {
      id: 'msg-fallback-1',
    },
    parts: [
      {
        id: 'part-start-1',
        sessionID: 'tool-fallback',
        messageID: 'msg-fallback-1',
        type: 'step-start',
      },
      {
        id: 'part-text-1',
        sessionID: 'tool-fallback',
        messageID: 'msg-fallback-1',
        type: 'text',
        text: '你好',
      },
      {
        id: 'part-finish-1',
        sessionID: 'tool-fallback',
        messageID: 'msg-fallback-1',
        type: 'step-finish',
        reason: 'stop',
        cost: 0.12,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 3,
          cache: {
            read: 0,
            write: 0,
          },
        },
      },
    ],
  }));

  const facts = await collect(run.facts);
  assert.deepEqual(facts, []);
  assert.deepEqual(await run.result(), { outcome: 'completed' });
});

test('provider adapter records prompt lifecycle diagnostics around session.prompt', async () => {
  const infos = [];
  const logger = {
    ...createLogger(),
    info: (message, extra) => infos.push({ message, extra }),
    child: () => logger,
  };
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    logger,
    bindings: [['tool-prompt-log', 'tool-prompt-log']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-prompt-log',
    runId: 'run-prompt-log',
    toolSessionId: 'tool-prompt-log',
    text: 'hello',
  });

  promptDeferred.resolve(createPromptResponse());
  await run.result();

  assert.deepEqual(
    infos.map((entry) => entry.message),
    [
      'provider_adapter.prompt.prepare_succeeded',
      'provider_adapter.prompt.started',
      'provider_adapter.prompt.completed',
    ],
  );
  assert.equal(infos[1].extra.toolSessionId, 'tool-prompt-log');
  assert.equal(infos[1].extra.runId, 'run-prompt-log');
  assert.equal(infos[1].extra.textLength, 5);
  assert.equal(infos[2].extra.toolSessionId, 'tool-prompt-log');
  assert.equal(infos[2].extra.terminalKind, 'completed');
  assert.equal(typeof infos[2].extra.durationMs, 'number');
});

test('provider adapter reuses legacy subagent mapping to route child facts into parent active run', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['ses-parent-1', 'ses-parent-1']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-subagent-active-run',
    runId: 'run-subagent-active-run',
    toolSessionId: 'ses-parent-1',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'session.created',
    properties: {
      info: {
        id: 'ses-child-1',
        parentID: 'ses-parent-1',
        title: 'research-agent',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'ses-child-1',
        id: 'msg-child-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses-child-1',
      messageID: 'msg-child-1',
      partID: 'part-child-1',
      field: 'text',
      delta: 'hello',
    },
  });
  await adapter.handleEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-child-1',
        sessionID: 'ses-child-1',
        messageID: 'msg-child-1',
        type: 'text',
        text: 'hello',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'ses-child-1',
        id: 'msg-child-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
          completed: '2026-05-22T12:00:01.000Z',
        },
        finish: 'stop',
      },
    },
  });

  promptDeferred.resolve(createPromptResponse());
  const facts = await collect(run.facts);

  assert.deepEqual(
    facts.map((fact) => ({
      type: fact.type,
      subagentSessionId: fact.subagentSessionId,
      subagentName: fact.subagentName,
    })),
    [
      {
        type: 'message.start',
        subagentSessionId: 'ses-child-1',
        subagentName: 'research-agent',
      },
      {
        type: 'text.delta',
        subagentSessionId: 'ses-child-1',
        subagentName: 'research-agent',
      },
      {
        type: 'text.done',
        subagentSessionId: 'ses-child-1',
        subagentName: 'research-agent',
      },
      {
        type: 'message.done',
        subagentSessionId: 'ses-child-1',
        subagentName: 'research-agent',
      },
    ],
  );
});

test('provider adapter does not emit detached child permission.asked after session.created prewarm', async () => {
  const outboundMessages = [];
  const adapter = createAdapter({
    bindings: [['ses-parent-outbound-1', 'ses-parent-outbound-1']],
  });
  await adapter.initialize({
    outbound: {
      emitOutboundMessage: async (input) => {
        outboundMessages.push({
          toolSessionId: input.toolSessionId,
          facts: await collect(input.facts),
        });
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'session.created',
    properties: {
      info: {
        id: 'ses-child-outbound-1',
        parentID: 'ses-parent-outbound-1',
        title: 'planner-agent',
      },
    },
  });
  const handled = await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'ses-child-outbound-1',
      id: 'perm-1',
      type: 'shell',
      title: 'Need permission',
      tool: {
        messageID: 'msg-perm-1',
        callID: 'call-perm-1',
      },
    },
  });

  assert.equal(handled, false);
  assert.deepEqual(outboundMessages, []);
});

test('provider adapter does not emit detached child permission.asked when subagent title is unavailable', async () => {
  const outboundMessages = [];
  const adapter = createAdapter({
    bindings: [['ses-parent-no-name-1', 'ses-parent-no-name-1']],
  });
  await adapter.initialize({
    outbound: {
      emitOutboundMessage: async (input) => {
        outboundMessages.push({
          toolSessionId: input.toolSessionId,
          facts: await collect(input.facts),
        });
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'session.created',
    properties: {
      info: {
        id: 'ses-child-no-name-1',
        parentID: 'ses-parent-no-name-1',
      },
    },
  });
  const handled = await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'ses-child-no-name-1',
      id: 'perm-no-name-1',
      tool: {
        messageID: 'msg-no-name-1',
        callID: 'call-no-name-1',
      },
    },
  });

  assert.equal(handled, false);
  assert.deepEqual(outboundMessages, []);
});

test('provider adapter fail-closes detached child permission.asked on subagent lookup failure when raw session is directly owned', async () => {
  const warnings = [];
  const logger = {
    ...createLogger(),
    warn: (message, extra) => warnings.push({ message, extra }),
    child: () => logger,
  };
  const outboundMessages = [];
  const adapter = createAdapter({
    logger,
    bindings: [['ses-child-fail-open-1', 'ses-child-fail-open-1']],
    session: {
      get: async () => {
        throw new Error('session lookup flaked');
      },
    },
  });
  await adapter.initialize({
    outbound: {
      emitOutboundMessage: async (input) => {
        outboundMessages.push({
          toolSessionId: input.toolSessionId,
          facts: await collect(input.facts),
        });
        return { applied: true };
      },
    },
  });

  const handled = await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'ses-child-fail-open-1',
      id: 'perm-fail-open-1',
      tool: {
        messageID: 'msg-fail-open-1',
        callID: 'call-fail-open-1',
      },
    },
  });

  assert.equal(handled, false);
  assert.deepEqual(outboundMessages, []);
  assert.deepEqual(warnings, [
    {
      message: 'provider_adapter.subagent_lookup_failed',
      extra: {
        toolSessionId: 'ses-child-fail-open-1',
        error: 'session lookup flaked',
      },
    },
  ]);
});

test('provider adapter records root session.created even when detached permission.asked is no longer emitted', async () => {
  let sessionGetCalls = 0;
  const outboundMessages = [];
  const adapter = createAdapter({
    bindings: [['ses-root-created-1', 'ses-root-created-1']],
    session: {
      get: async (input) => {
        sessionGetCalls += 1;
        return {
          data: {
            id: input?.path?.id ?? input?.sessionID ?? 'session-1',
            directory: '/workspace/test',
          },
        };
      },
    },
  });
  await adapter.initialize({
    outbound: {
      emitOutboundMessage: async (input) => {
        outboundMessages.push({
          toolSessionId: input.toolSessionId,
          facts: await collect(input.facts),
        });
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'session.created',
    properties: {
      info: {
        id: 'ses-root-created-1',
        title: 'root-session-title',
      },
    },
  });

  const handled = await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'ses-root-created-1',
      id: 'perm-root-created-1',
      tool: {
        messageID: 'msg-root-created-1',
        callID: 'call-root-created-1',
      },
    },
  });

  assert.equal(handled, false);
  assert.equal(sessionGetCalls, 0);
  assert.deepEqual(outboundMessages, []);
});

test('provider adapter cleans child tracking state after subagent run completes', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['ses-parent-cleanup-1', 'ses-parent-cleanup-1']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });

  const run = await adapter.runMessage({
    traceId: 'trace-subagent-cleanup',
    runId: 'run-subagent-cleanup',
    toolSessionId: 'ses-parent-cleanup-1',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'session.created',
    properties: {
      info: {
        id: 'ses-child-cleanup-1',
        parentID: 'ses-parent-cleanup-1',
        title: 'cleanup-agent',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'ses-child-cleanup-1',
        id: 'msg-cleanup-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
          completed: '2026-05-22T12:00:01.000Z',
        },
        finish: 'stop',
      },
    },
  });

  promptDeferred.resolve(createPromptResponse());
  await collect(run.facts);
  await run.result();

  assert.equal(adapter.hasPartKindTrackingSession('ses-child-cleanup-1'), false);
  assert.equal(adapter.hasAssistantMessageTrackingSession('ses-child-cleanup-1'), false);
});

test('provider adapter resolves ProviderRun.result() only after facts drain closes', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-run-completion', 'tool-run-completion']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-run-completion',
    runId: 'run-run-completion',
    toolSessionId: 'tool-run-completion',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-run-completion',
        id: 'msg-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
          completed: '2026-05-22T12:00:01.000Z',
        },
        finish: 'stop',
      },
    },
  });

  let resolved = false;
  const resultPromise = run.result().then((result) => {
    resolved = true;
    return result;
  });

  promptDeferred.resolve(createPromptResponse());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false);

  assert.deepEqual(await resultPromise, { outcome: 'completed' });
  const facts = await collect(run.facts);
  assert.deepEqual(
    facts.map((fact) => fact.type),
    ['message.start', 'message.done'],
  );
});

test('provider adapter maps permission.asked tool context and synthesizes compatible partId fallback', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-permission', 'tool-permission']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-permission',
    runId: 'run-permission',
    toolSessionId: 'tool-permission',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'tool-permission',
      id: 'perm-1',
      partID: 'part-permission-1',
      tool: {
        messageID: 'msg-tool-1',
        callID: 'call-tool-1',
      },
      metadata: {
        scope: 'workspace',
      },
    },
  });
  await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'tool-permission',
      id: 'perm-2',
      metadata: {
        scope: 'fallback',
      },
    },
  });

  promptDeferred.resolve(createPromptResponse());
  const facts = await collect(run.facts);

  assert.equal(facts.length, 2);
  assert.deepEqual(facts[0], {
    type: 'permission.ask',
    messageId: 'msg-tool-1',
    partId: 'part-permission-1',
    permissionId: 'perm-1',
    metadata: {
      scope: 'workspace',
    },
    raw: {
      sessionID: 'tool-permission',
      id: 'perm-1',
      partID: 'part-permission-1',
      tool: {
        messageID: 'msg-tool-1',
        callID: 'call-tool-1',
      },
      metadata: {
        scope: 'workspace',
      },
    },
  });
  assert.deepEqual(
    {
      ...facts[1],
      partId: '<generated>',
    },
    {
      type: 'permission.ask',
      partId: '<generated>',
      permissionId: 'perm-2',
      metadata: {
        scope: 'fallback',
      },
      raw: {
        sessionID: 'tool-permission',
        id: 'perm-2',
        metadata: {
          scope: 'fallback',
        },
      },
    },
  );
  assert.match(facts[1].partId, /^prt_[0-9a-f]{32}$/);
});

test('provider adapter maps question.asked multiple to question.ask multiSelect', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-question', 'tool-question']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-question',
    runId: 'run-question',
    toolSessionId: 'tool-question',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-question',
        id: 'msg-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'question.asked',
    properties: {
      sessionID: 'tool-question',
      id: 'question-1',
      partID: 'part-question-1',
      tool: {
        messageID: 'msg-1',
        callID: 'call-question-1',
      },
      questions: [
        {
          question: 'Pick one',
          header: 'Header',
          multiple: true,
          options: [
            { label: 'A' },
            { label: 'B' },
          ],
        },
      ],
    },
  });

  promptDeferred.resolve(createPromptResponse());
  const facts = await collect(run.facts);

  assert.deepEqual(facts, [
    {
      type: 'message.start',
      messageId: 'msg-1',
      raw: {
        info: {
          sessionID: 'tool-question',
          id: 'msg-1',
          role: 'assistant',
          time: {
            created: '2026-05-22T12:00:00.000Z',
          },
        },
      },
    },
    {
      type: 'question.ask',
      messageId: 'msg-1',
      partId: 'part-question-1',
      questionId: 'question-1',
      questions: [
        {
          question: 'Pick one',
          header: 'Header',
          multiSelect: true,
          options: [
            { label: 'A' },
            { label: 'B' },
          ],
        },
      ],
      raw: {
        sessionID: 'tool-question',
        id: 'question-1',
        partID: 'part-question-1',
        tool: {
          messageID: 'msg-1',
          callID: 'call-question-1',
        },
        questions: [
          {
            question: 'Pick one',
            header: 'Header',
            multiple: true,
            options: [
              { label: 'A' },
              { label: 'B' },
            ],
          },
        ],
      },
    },
  ]);
});

test('provider adapter synthesizes question partId fallback without reusing questionId', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-question-fallback', 'tool-question-fallback']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-question-fallback',
    runId: 'run-question-fallback',
    toolSessionId: 'tool-question-fallback',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-question-fallback',
        id: 'msg-fallback-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'question.asked',
    properties: {
      sessionID: 'tool-question-fallback',
      id: 'question-fallback-1',
      tool: {
        messageID: 'msg-fallback-1',
        callID: 'call-question-fallback-1',
      },
      questions: [
        {
          question: 'Pick fallback',
          options: [{ label: 'A' }],
        },
      ],
    },
  });

  promptDeferred.resolve(createPromptResponse());
  const facts = await collect(run.facts);

  assert.equal(facts.length, 2);
  assert.deepEqual(facts[0], {
    type: 'message.start',
    messageId: 'msg-fallback-1',
    raw: {
      info: {
        sessionID: 'tool-question-fallback',
        id: 'msg-fallback-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
        },
      },
    },
  });
  assert.deepEqual(
    {
      ...facts[1],
      partId: '<generated>',
    },
    {
      type: 'question.ask',
      messageId: 'msg-fallback-1',
      partId: '<generated>',
      questionId: 'question-fallback-1',
      questions: [
        {
          question: 'Pick fallback',
          options: [{ label: 'A' }],
        },
      ],
      raw: {
        sessionID: 'tool-question-fallback',
        id: 'question-fallback-1',
        tool: {
          messageID: 'msg-fallback-1',
          callID: 'call-question-fallback-1',
        },
        questions: [
          {
            question: 'Pick fallback',
            options: [{ label: 'A' }],
          },
        ],
      },
    },
  );
  assert.match(facts[1].partId, /^prt_[0-9a-f]{32}$/);
  assert.notEqual(facts[1].partId, 'question-fallback-1');
});

test('provider adapter drops orphan text part facts and records protocol diagnostics before runtime validation', async () => {
  const warnings = [];
  const logger = {
    ...createLogger(),
    warn: (message, extra) => warnings.push({ message, extra }),
    child: () => logger,
  };
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    logger,
    bindings: [['tool-orphan-part', 'tool-orphan-part']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-orphan-part',
    runId: 'run-orphan-part',
    toolSessionId: 'tool-orphan-part',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-1',
        sessionID: 'tool-orphan-part',
        messageID: 'msg-1',
        type: 'text',
        text: 'orphan text',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: 'tool-orphan-part',
      messageID: 'msg-1',
      partID: 'part-1',
      field: 'text',
      delta: 'delta text',
    },
  });

  promptDeferred.resolve(createPromptResponse());
  const facts = await collect(run.facts);

  assert.deepEqual(facts, []);
  assert.deepEqual(warnings, [
    {
      message: 'provider_adapter.protocol_diagnostic',
      extra: {
        code: 'text_done_without_open_message',
        toolSessionId: 'tool-orphan-part',
        messageId: 'msg-1',
        partId: 'part-1',
        partType: 'text',
      },
    },
    {
      message: 'provider_adapter.protocol_diagnostic',
      extra: {
        code: 'text_delta_without_open_message',
        toolSessionId: 'tool-orphan-part',
        messageId: 'msg-1',
        partId: 'part-1',
        partType: 'text',
      },
    },
    {
      message: 'provider_adapter.protocol_diagnostic',
      extra: {
        toolSessionId: 'tool-orphan-part',
        runId: 'run-orphan-part',
        code: 'facts_drain_timeout_without_terminal_candidate',
      },
    },
  ]);
});

test('provider adapter maps assistant info.error prompt terminal to failed result while keeping session.error fact visible', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-failed', 'tool-failed']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-failed',
    runId: 'run-failed',
    toolSessionId: 'tool-failed',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'tool-failed',
      error: 'model backend failed',
    },
  });

  promptDeferred.resolve(createPromptResponse({
    info: {
      error: {
        name: 'APIError',
        data: {
          message: 'model backend failed',
          statusCode: 429,
          isRetryable: true,
          responseBody: 'Too many requests',
        },
      },
    },
  }));

  const facts = await collect(run.facts);
  assert.deepEqual(facts, [{
    type: 'session.error',
    error: {
      code: 'internal_error',
      message: 'model backend failed',
    },
    raw: {
      sessionID: 'tool-failed',
      error: 'model backend failed',
    },
  }]);
  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'internal_error',
      message: 'APIError: model backend failed statusCode=429',
      details: {
        name: 'APIError',
        message: 'model backend failed',
        statusCode: 429,
        isRetryable: true,
        responseBody: 'Too many requests',
      },
    },
  });
});

test('provider adapter keeps legacy top-level assistant error fields compatible', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-failed-legacy', 'tool-failed-legacy']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-failed-legacy',
    toolSessionId: 'tool-failed-legacy',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'tool-failed-legacy',
      error: 'legacy backend failed',
    },
  });

  promptDeferred.resolve(createPromptResponse({
    info: {
      error: {
        name: 'APIError',
        message: 'legacy backend failed',
        statusCode: 429,
        retryable: true,
        providerID: 'openai',
      },
    },
  }));

  const facts = await collect(run.facts);
  assert.deepEqual(facts, [{
    type: 'session.error',
    error: {
      code: 'internal_error',
      message: 'legacy backend failed',
    },
    raw: {
      sessionID: 'tool-failed-legacy',
      error: 'legacy backend failed',
    },
  }]);
  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'internal_error',
      message: 'APIError: legacy backend failed statusCode=429',
      details: {
        name: 'APIError',
        message: 'legacy backend failed',
        statusCode: 429,
        retryable: true,
        providerID: 'openai',
      },
    },
  });
});

test('provider adapter keeps bare APIError when prompt terminal only receives assistant error name', async () => {
  const infos = [];
  const logger = {
    ...createLogger(),
    info: (message, extra) => infos.push({ message, extra }),
    child: () => logger,
  };
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    logger,
    bindings: [['tool-api-error-name-only', 'tool-api-error-name-only']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-api-error-name-only',
    runId: 'run-api-error-name-only',
    toolSessionId: 'tool-api-error-name-only',
    text: 'hello',
  });

  promptDeferred.resolve(createPromptResponse({
    info: {
      error: {
        name: 'APIError',
      },
    },
  }));

  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'internal_error',
      message: 'APIError',
      details: {
        name: 'APIError',
      },
    },
  });
  assert.deepEqual(
    infos.find((entry) => entry.message === 'provider_adapter.prompt.completed'),
    {
      message: 'provider_adapter.prompt.completed',
      extra: {
        toolSessionId: 'tool-api-error-name-only',
        opencodeSessionId: 'tool-api-error-name-only',
        runId: 'run-api-error-name-only',
        durationMs: infos.find((entry) => entry.message === 'provider_adapter.prompt.completed').extra.durationMs,
        terminalKind: 'failed',
        terminalErrorCode: 'internal_error',
        terminalErrorMessage: 'APIError',
        terminalErrorDetails: {
          name: 'APIError',
        },
      },
    },
  );
});

test('provider adapter keeps draining after prompt terminal and closes on the last terminal candidate', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-continuation', 'tool-continuation']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-continuation',
    runId: 'run-continuation',
    toolSessionId: 'tool-continuation',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-continuation',
        id: 'msg-1',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z', completed: '2026-05-22T12:00:01.000Z' },
        finish: 'tool-calls',
      },
    },
  });

  promptDeferred.resolve(createPromptResponse());

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-continuation',
        id: 'msg-2',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:02.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-2',
        sessionID: 'tool-continuation',
        messageID: 'msg-2',
        type: 'text',
        text: 'tail reply',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-continuation',
        id: 'msg-2',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:02.000Z', completed: '2026-05-22T12:00:03.000Z' },
        finish: 'stop',
      },
    },
  });

  assert.deepEqual(await run.result(), { outcome: 'completed' });
  const facts = await collect(run.facts);
  assert.deepEqual(
    facts.map((fact) => [fact.type, 'messageId' in fact ? fact.messageId : undefined]),
    [
      ['message.start', 'msg-1'],
      ['message.done', 'msg-1'],
      ['message.start', 'msg-2'],
      ['text.done', 'msg-2'],
      ['message.done', 'msg-2'],
    ],
  );
});

test('provider adapter closes facts by drain timeout when no terminal candidate ever appears', async () => {
  const warnings = [];
  const logger = {
    ...createLogger(),
    warn: (message, extra) => warnings.push({ message, extra }),
    child: () => logger,
  };
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    logger,
    bindings: [['tool-no-terminal-candidate', 'tool-no-terminal-candidate']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-no-terminal-candidate',
    runId: 'run-no-terminal-candidate',
    toolSessionId: 'tool-no-terminal-candidate',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-no-terminal-candidate',
        id: 'msg-1',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z', completed: '2026-05-22T12:00:01.000Z' },
        finish: 'tool-calls',
      },
    },
  });

  promptDeferred.resolve(createPromptResponse());
  assert.deepEqual(await run.result(), { outcome: 'completed' });

  const facts = await collect(run.facts);
  assert.deepEqual(
    facts.map((fact) => [fact.type, 'messageId' in fact ? fact.messageId : undefined]),
    [
      ['message.start', 'msg-1'],
      ['message.done', 'msg-1'],
    ],
  );
  assert.deepEqual(warnings, [{
    message: 'provider_adapter.protocol_diagnostic',
    extra: {
      toolSessionId: 'tool-no-terminal-candidate',
      runId: 'run-no-terminal-candidate',
      code: 'facts_drain_timeout_without_terminal_candidate',
    },
  }]);
});

test('provider adapter records diagnostic when assistant completed arrives without a created event', async () => {
  const warnings = [];
  const logger = {
    ...createLogger(),
    warn: (message, extra) => warnings.push({ message, extra }),
    child: () => logger,
  };
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    logger,
    bindings: [['tool-completed-without-created', 'tool-completed-without-created']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-completed-without-created',
    runId: 'run-completed-without-created',
    toolSessionId: 'tool-completed-without-created',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-completed-without-created',
        id: 'msg-1',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:01.000Z' },
        finish: 'stop',
      },
    },
  });

  promptDeferred.resolve(createPromptResponse());
  assert.deepEqual(await run.result(), { outcome: 'completed' });
  const facts = await collect(run.facts);
  assert.deepEqual(facts, []);
  assert.deepEqual(warnings, [{
    message: 'provider_adapter.protocol_diagnostic',
    extra: {
      code: 'assistant_message_completed_without_created',
      toolSessionId: 'tool-completed-without-created',
      messageId: 'msg-1',
      finish: 'stop',
      hasError: false,
    },
  }]);
});

test('provider adapter ignores detached permission.replied when no active run owns the event', async () => {
  const outboundCalls = [];
  const adapter = createAdapter({
    bindings: [['tool-outbound', 'tool-outbound']],
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage(input) {
        const facts = await collect(input.facts);
        outboundCalls.push({
          toolSessionId: input.toolSessionId,
          messageId: input.messageId,
          facts,
        });
        return { applied: true };
      },
    },
  });

  const handled = await adapter.handleEvent({
    type: 'permission.replied',
    properties: {
      sessionID: 'tool-outbound',
      requestID: 'permission-1',
      reply: 'always',
    },
  });

  assert.strictEqual(handled, false);
  assert.deepEqual(outboundCalls, []);
});

test('provider adapter records received upstream event routing diagnostics', async () => {
  const debugs = [];
  const logger = {
    ...createLogger(),
    debug: (message, extra) => debugs.push({ message, extra }),
    child: () => logger,
  };
  const outboundCalls = [];
  const adapter = createAdapter({
    logger,
    bindings: [['tool-session-42', 'tool-session-42']],
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage(input) {
        outboundCalls.push(input);
        return { applied: true };
      },
    },
  });

  const handled = await adapter.handleEvent({
    type: 'session.updated',
    properties: {
      info: {
        id: 'tool-session-42',
        title: '讨论项目架构',
      },
    },
  });

  assert.equal(handled, false);
  assert.equal(outboundCalls.length, 0);
  assert.deepEqual(
    debugs.map((entry) => entry.message),
    ['provider_adapter.event.received'],
  );
  assert.deepEqual(debugs[0].extra, {
    eventType: 'session.updated',
    translated: true,
    toolSessionId: 'tool-session-42',
    resolvedToolSessionId: 'tool-session-42',
    hasActiveRun: false,
    hasRuntimeContext: true,
  });
});

test('provider adapter ignores detached session.updated title continuation', async () => {
  const outboundCalls = [];
  const adapter = createAdapter({
    bindings: [['tool-session-42', 'tool-session-42']],
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage(input) {
        const facts = await collect(input.facts);
        outboundCalls.push({ input, facts });
        return { applied: true };
      },
    },
  });

  const handled = await adapter.handleEvent({
    type: 'session.updated',
    properties: {
      info: {
        id: 'tool-session-42',
        title: '讨论项目架构',
      },
    },
  });

  assert.strictEqual(handled, false);
  assert.deepEqual(outboundCalls, []);
});

test('provider adapter ignores detached session.updated without title silently', async () => {
  const warnings = [];
  const logger = {
    ...createLogger(),
    warn: (message, extra) => warnings.push({ message, extra }),
    child: () => logger,
  };
  const adapter = createAdapter({
    logger,
    bindings: [['tool-session-42', 'tool-session-42']],
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        return { applied: true };
      },
    },
  });

  const handled = await adapter.handleEvent({
    type: 'session.updated',
    properties: {
      info: {
        id: 'tool-session-42',
      },
    },
  });

  assert.strictEqual(handled, false);
  assert.deepEqual(warnings, []);
});

test('provider adapter ignores message.updated when no active run owns it', async () => {
  const adapter = createAdapter();

  const handled = await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-session-42',
        id: 'msg-42',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
          completed: '2026-05-22T12:00:01.000Z',
        },
        finish: 'stop',
      },
    },
  });

  assert.strictEqual(handled, false);
});
