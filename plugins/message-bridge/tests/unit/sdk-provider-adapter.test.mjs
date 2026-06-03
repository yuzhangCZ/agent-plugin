import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryOpencodeSessionOwnershipResolver,
  InMemorySessionModelOverrideStore,
  InMemoryToolSessionBindingStore,
  OpencodeSessionGatewayAdapter,
  SimpleSlashCommandParser,
} from '../../src/adapter/index.ts';
import { SubagentSessionMapper } from '../../src/session/SubagentSessionMapper.ts';
import {
  CreateSessionRequestNormalizer,
  CreateSessionUseCase,
  DefaultSlashCommandReplyPresenter,
  SlashCommandExecutor,
} from '../../src/usecase/index.ts';
import { OpenCodeProviderAdapter } from '../../src/runtime/sdk/OpenCodeProviderAdapter.ts';
import { HostSessionRunCoordinator } from '../../src/runtime/sdk/HostSessionRunCoordinator.ts';
import { FactDrainTracker } from '../../src/runtime/sdk/OpenCodeProviderAdapter.fact-drain.ts';
import { TuiOutboundRunRegistry } from '../../src/runtime/sdk/OpenCodeProviderAdapter.outbound-run.ts';
import {
  ActiveRunRegistry,
} from '../../src/runtime/sdk/OpenCodeProviderAdapter.run.ts';
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

function createPromptActionResult(overrides = {}) {
  return {
    success: true,
    data: {
      message: {
        info: {
          id: overrides.messageId ?? 'msg-prompt-1',
          cost: 0.12,
          tokens: {
            input: 10,
            output: 20,
            reasoning: 3,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [],
      },
      terminal: overrides.terminal ?? { kind: 'completed' },
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

function createCapturingLogger(logs) {
  const write = (level) => (message, extra) => {
    logs.push({ level, message, extra });
  };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => createCapturingLogger(logs),
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

function withTimeout(promise, message, timeoutMs = 1000) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function queuePermissionBehindBlockedTuiOutboundRun(adapter, input) {
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: input.hostSessionId,
        id: input.messageId,
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: input.hostSessionId,
        id: input.messageId,
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:01.000Z' },
        finish: 'stop',
      },
    },
  });
  await withTimeout(input.firstRunCollected.promise, 'expected first outbound run to reach emission');

  await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: input.hostSessionId,
      id: input.permissionId,
      permission: 'shell',
      tool: {
        messageID: input.queuedMessageId,
      },
    },
  });
}

function createAdapter(overrides = {}) {
  const sdkClient = 'sdkClient' in overrides ? overrides.sdkClient : createSdkClient(overrides);
  const logger = overrides.logger ?? createLogger();
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  const modelOverrideStore = new InMemorySessionModelOverrideStore();
  const opencodeSessionGatewayAdapter = new OpencodeSessionGatewayAdapter(() => sdkClient);
  const createSessionUseCase = new CreateSessionUseCase(opencodeSessionGatewayAdapter);
  const createSessionRequestNormalizer = new CreateSessionRequestNormalizer();
  const hostSessionCreationPort = {
    createSession: async (input) => {
      const normalized = createSessionRequestNormalizer.fromChatContext({
        assistantId: input?.assistantId,
        imGroupId: input?.imGroupId,
      });
      const result = await createSessionUseCase.execute({
        ...normalized,
        directory: overrides.bridgeDirectory ?? '/workspace/test',
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
  const chatPreprocessor = overrides.chatPreprocessor ?? new SdkChatPreprocessor({
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
    ...(overrides.createSessionCommandPort ? { createSessionCommandPort: overrides.createSessionCommandPort } : {}),
    ...(overrides.closeSessionCommandPort ? { closeSessionCommandPort: overrides.closeSessionCommandPort } : {}),
    ...(overrides.abortSessionCommandPort ? { abortSessionCommandPort: overrides.abortSessionCommandPort } : {}),
    ...(overrides.questionReplyCommandPort ? { questionReplyCommandPort: overrides.questionReplyCommandPort } : {}),
    ...(overrides.permissionReplyCommandPort ? { permissionReplyCommandPort: overrides.permissionReplyCommandPort } : {}),
    ...(overrides.hostEventPort ? { hostEventPort: overrides.hostEventPort } : {}),
    ...(overrides.pendingInteractionRecorder ? { pendingInteractionRecorder: overrides.pendingInteractionRecorder } : {}),
    ...(overrides.finalIdleTimeoutMs !== undefined ? { finalIdleTimeoutMs: overrides.finalIdleTimeoutMs } : {}),
    effectiveDirectory: overrides.bridgeDirectory ?? '/workspace/test',
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

test('ActiveRunRegistry returns host session head in FIFO order and ignores stale cleanup', () => {
  const logger = createLogger();
  const cleanups = [];
  const registry = new ActiveRunRegistry();
  const first = registry.create({
    anchorSessionId: 'conversation-a',
    hostSessionId: 'host-shared',
    runId: 'run-a',
    initialTrackingSessionId: 'host-shared',
    logger,
    onCleanup: (input) => cleanups.push(input),
  });
  const second = registry.create({
    anchorSessionId: 'conversation-b',
    hostSessionId: 'host-shared',
    runId: 'run-b',
    initialTrackingSessionId: 'host-shared',
    logger,
    onCleanup: (input) => cleanups.push(input),
  });

  assert.equal(registry.getHeadByHostSession('host-shared'), first);
  assert.equal(registry.get('conversation-a'), first);
  assert.equal(registry.get('conversation-b'), second);

  assert.deepEqual(registry.deleteIfCurrentRun('conversation-a', 'stale-run'), {
    deleted: false,
    currentRunId: 'run-a',
  });
  assert.equal(registry.getHeadByHostSession('host-shared'), first);

  assert.deepEqual(registry.deleteIfCurrentRun('conversation-a', 'run-a'), {
    deleted: true,
    currentRunId: 'run-a',
  });
  assert.equal(registry.getHeadByHostSession('host-shared'), second);
});

test('ActiveProviderRunHandle forceAbortAndClose is idempotent and ignores later facts', async () => {
  const logger = createLogger();
  const cleanups = [];
  const registry = new ActiveRunRegistry();
  const run = registry.create({
    anchorSessionId: 'conversation-a',
    hostSessionId: 'host-a',
    runId: 'run-a',
    initialTrackingSessionId: 'host-a',
    logger,
    onCleanup: (input) => cleanups.push(input),
  });

  run.forceAbortAndClose('abort_session');
  run.forceAbortAndClose('abort_session');
  run.pushFacts({
    recognized: true,
    facts: [{ type: 'text.delta', content: 'late' }],
  });

  assert.deepEqual(await collect(run.queue), []);
  assert.deepEqual(await run.result(), { outcome: 'aborted' });
  assert.equal(cleanups.length, 1);
  assert.equal(cleanups[0].runId, 'run-a');
});

test('FactDrainTracker does not repeatedly rearm timers while close gate is false', async () => {
  let canCloseChecks = 0;
  let closeCalls = 0;
  const tracker = new FactDrainTracker({
    mode: 'outbound_run',
    anchorSessionId: 'tool-fact-drain-gate',
    runId: 'run-fact-drain-gate',
    queue: {
      close: () => {
        closeCalls += 1;
      },
    },
    logger: createLogger(),
    onClosed: () => undefined,
    canCloseFacts: () => {
      canCloseChecks += 1;
      return false;
    },
    quietPeriodMs: 1,
    drainTimeoutMs: 1,
    finalIdleTimeoutMs: 10_000,
  });

  tracker.noteRelevantEvent('msg-fact-drain-gate');
  tracker.startDrainTimeout();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(closeCalls, 0);
  assert.equal(canCloseChecks <= 2, true);
  tracker.closeFacts('manual');
});

test('ActiveRunRegistry aborts superseded run when same anchor creates a new run', async () => {
  const logger = createLogger();
  const registry = new ActiveRunRegistry();
  const first = registry.create({
    anchorSessionId: 'conversation-a',
    hostSessionId: 'host-a',
    runId: 'run-a',
    initialTrackingSessionId: 'host-a',
    logger,
    onCleanup: () => undefined,
  });
  const second = registry.create({
    anchorSessionId: 'conversation-a',
    hostSessionId: 'host-a',
    runId: 'run-b',
    initialTrackingSessionId: 'host-a',
    logger,
    onCleanup: () => undefined,
  });

  assert.equal(registry.get('conversation-a'), second);
  assert.equal(registry.getHeadByHostSession('host-a'), second);
  assert.deepEqual(await withTimeout(first.result(), 'superseded run did not settle'), { outcome: 'aborted' });
  assert.deepEqual(await collect(first.queue), []);
});

test('provider adapter records host run queue scheduling diagnostics', async () => {
  const logs = [];
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    logger: createCapturingLogger(logs),
    bindings: [
      ['conversation-run-queue-a', 'host-run-queue-shared'],
      ['conversation-run-queue-b', 'host-run-queue-shared'],
    ],
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    promptCount += 1;
    return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
  };

  const firstRun = await adapter.runMessage({
    traceId: 'trace-run-queue-1',
    runId: 'run-queue-1',
    toolSessionId: 'conversation-run-queue-a',
    text: 'first',
  });
  const secondRun = await adapter.runMessage({
    traceId: 'trace-run-queue-2',
    runId: 'run-queue-2',
    toolSessionId: 'conversation-run-queue-b',
    text: 'second',
  });

  await Promise.resolve();
  assert.equal(promptCount, 1);
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-run-queue-1',
        sessionID: 'host-run-queue-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  firstPrompt.resolve(createPromptActionResult({ messageId: 'msg-run-queue-1' }));
  await firstRun.result();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCount, 2);
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-run-queue-2',
        sessionID: 'host-run-queue-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  secondPrompt.resolve(createPromptActionResult({ messageId: 'msg-run-queue-2' }));
  await secondRun.result();

  const debugs = logs.filter((entry) => entry.level === 'debug');
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.run_queue.enqueued'
    && entry.extra?.hostSessionId === 'host-run-queue-shared'
    && entry.extra?.anchorSessionId === 'conversation-run-queue-a'
    && entry.extra?.runId === 'run-queue-1'), true);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.run_queue.enqueued'
    && entry.extra?.hostSessionId === 'host-run-queue-shared'
    && entry.extra?.anchorSessionId === 'conversation-run-queue-b'
    && entry.extra?.runId === 'run-queue-2'), true);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.run_queue.drain_skipped'
    && entry.extra?.hostSessionId === 'host-run-queue-shared'
    && entry.extra?.reason === 'already_draining'), true);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.run_queue.prompt_started'
    && entry.extra?.runId === 'run-queue-1'), true);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.run_queue.prompt_started'
    && entry.extra?.runId === 'run-queue-2'), true);
});

test('HostSessionRunCoordinator logs scheduler work failure and fails run closed', async () => {
  const logs = [];
  const registry = new ActiveRunRegistry();
  const run = registry.create({
    anchorSessionId: 'tool-run-queue-failed',
    hostSessionId: 'host-run-queue-failed',
    runId: 'run-queue-failed',
    initialTrackingSessionId: 'host-run-queue-failed',
    logger: createCapturingLogger(logs),
    onCleanup: () => undefined,
  });
  const coordinator = new HostSessionRunCoordinator(createCapturingLogger(logs));

  coordinator.enqueue(run, async () => {
    throw new Error('scheduler boom');
  });

  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'internal_error',
      message: 'scheduler boom',
    },
  });
  assert.equal(logs.some((entry) => entry.level === 'error'
    && entry.message === 'provider_adapter.run_queue.prompt_task_failed'
    && entry.extra?.runId === 'run-queue-failed'
    && entry.extra?.error === 'scheduler boom'), true);
});

test('provider adapter delegates question replies to session-isolation command port', async () => {
  const calls = [];
  let legacyReplyCalls = 0;
  const adapter = createAdapter({
    questionReplyCommandPort: {
      execute: async (input) => {
        calls.push(input);
        return { applied: true };
      },
    },
    question: {
      reply: async () => {
        legacyReplyCalls += 1;
        throw new Error('legacy question reply should not be used');
      },
    },
  });

  assert.deepEqual(await adapter.replyQuestion({
    traceId: 'trace-question-port',
    questionId: 'question-a',
    answers: [['answer-a']],
  }), { applied: true });
  assert.deepEqual(calls, [{ questionId: 'question-a', answer: 'answer-a' }]);
  assert.equal(legacyReplyCalls, 0);
});

test('provider adapter fails closed when session-isolation question reply command rejects', async () => {
  let legacyReplyCalls = 0;
  const adapter = createAdapter({
    questionReplyCommandPort: {
      execute: async () => {
        throw new Error('question_pending_interaction_not_found');
      },
    },
    question: {
      reply: async () => {
        legacyReplyCalls += 1;
        return { data: true };
      },
    },
  });

  await assert.rejects(
    () => adapter.replyQuestion({
      traceId: 'trace-question-port-failed',
      questionId: 'question-missing',
      answers: [['answer-a']],
    }),
    /question_pending_interaction_not_found/,
  );
  assert.equal(legacyReplyCalls, 0);
});

test('provider adapter delegates permission replies to session-isolation command port', async () => {
  const calls = [];
  let legacyReplyCalls = 0;
  const adapter = createAdapter({
    permissionReplyCommandPort: {
      execute: async (input) => {
        calls.push(input);
        return { applied: true };
      },
    },
    permission: {
      reply: async () => {
        legacyReplyCalls += 1;
        throw new Error('legacy permission reply should not be used');
      },
    },
  });

  assert.deepEqual(await adapter.replyPermission({
    traceId: 'trace-permission-port',
    permissionId: 'permission-a',
    reply: 'once',
  }), { applied: true });
  assert.deepEqual(calls, [{ permissionId: 'permission-a', response: 'once' }]);
  assert.equal(legacyReplyCalls, 0);
});

test('provider adapter fails closed when session-isolation permission reply command rejects', async () => {
  let legacyReplyCalls = 0;
  const adapter = createAdapter({
    permissionReplyCommandPort: {
      execute: async () => {
        throw new Error('permission_pending_interaction_not_found');
      },
    },
    permission: {
      reply: async () => {
        legacyReplyCalls += 1;
        return { data: true };
      },
    },
  });

  await assert.rejects(
    () => adapter.replyPermission({
      traceId: 'trace-permission-port-failed',
      permissionId: 'permission-missing',
      reply: 'deny',
    }),
    /permission_pending_interaction_not_found/,
  );
  assert.equal(legacyReplyCalls, 0);
});

test('provider adapter delegates abort session to session-isolation command port', async () => {
  const calls = [];
  let legacyAbortCalls = 0;
  const adapter = createAdapter({
    abortSessionCommandPort: {
      execute: async (input) => {
        calls.push(input);
        return { kind: 'aborted', toolSessionId: input.toolSessionId, hostSessionId: 'host-abort-port' };
      },
    },
    session: {
      abort: async () => {
        legacyAbortCalls += 1;
        throw new Error('legacy abort should not be used');
      },
    },
  });

  assert.deepEqual(await adapter.abortSession({
    traceId: 'trace-abort-port',
    toolSessionId: 'tool-abort-port',
  }), { applied: true });
  assert.deepEqual(calls, [{ toolSessionId: 'tool-abort-port' }]);
  assert.equal(legacyAbortCalls, 0);
});

test('provider adapter fails closed when session-isolation abort command reports inactive session', async () => {
  let legacyAbortCalls = 0;
  const adapter = createAdapter({
    abortSessionCommandPort: {
      execute: async (input) => ({ kind: 'not_active', toolSessionId: input.toolSessionId }),
    },
    session: {
      abort: async () => {
        legacyAbortCalls += 1;
        return { data: true };
      },
    },
  });

  await assert.rejects(
    () => adapter.abortSession({
      traceId: 'trace-abort-port-not-active',
      toolSessionId: 'tool-abort-missing',
    }),
    (error) => {
      assert.equal(error.message, 'abort_session_not_active');
      assert.deepEqual(error.errorEvidence, {
        sourceOperation: 'session.abort',
        sourceErrorCode: 'session_not_found',
      });
      return true;
    },
  );
  assert.equal(legacyAbortCalls, 0);
});

test('provider adapter abortSession command port closes all runs under returned host session', async () => {
  const promptA = createDeferred();
  const promptB = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    session: {
      prompt: async () => {
        promptCount += 1;
        return promptCount === 1 ? promptA.promise : promptB.promise;
      },
    },
    abortSessionCommandPort: {
      execute: async (input) => ({
        kind: 'aborted',
        toolSessionId: input.toolSessionId,
        hostSessionId: 'host-shared',
      }),
    },
  });

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.deepEqual(await adapter.abortSession({ toolSessionId: 'conversation-b' }), { applied: true });
  assert.deepEqual(await runA.result(), { outcome: 'aborted' });
  assert.deepEqual(await runB.result(), { outcome: 'aborted' });
  assert.deepEqual(await collect(runA.facts), []);
  assert.deepEqual(await collect(runB.facts), []);
});

test('provider adapter abortSession fallback closes all runs under resolved host session', async () => {
  const abortCalls = [];
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    session: {
      prompt: async () => new Promise(() => undefined),
      abort: async (input) => {
        abortCalls.push(input);
        return { data: true };
      },
    },
  });

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.deepEqual(await adapter.abortSession({ toolSessionId: 'conversation-b' }), { applied: true });
  assert.equal(abortCalls.length, 1);
  assert.deepEqual(await runA.result(), { outcome: 'aborted' });
  assert.deepEqual(await runB.result(), { outcome: 'aborted' });
});

test('provider adapter abortSession clears queued TUI outbound run events for aborted host session', async () => {
  const emittedRuns = [];
  const pendingRecords = [];
  const firstRunCollected = createDeferred();
  const releaseFirstEmit = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-abort-outbound', 'ses-abort-outbound']],
    pendingInteractionRecorder: {
      record: (input) => pendingRecords.push(input),
    },
    abortSessionCommandPort: {
      execute: async (input) => ({
        kind: 'aborted',
        toolSessionId: input.toolSessionId,
        hostSessionId: 'ses-abort-outbound',
      }),
    },
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        emittedRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        firstRunCollected.resolve();
        await releaseFirstEmit.promise;
        return { applied: true };
      },
    },
  });

  await queuePermissionBehindBlockedTuiOutboundRun(adapter, {
    hostSessionId: 'ses-abort-outbound',
    messageId: 'msg-abort-outbound',
    queuedMessageId: 'msg-abort-outbound-queued',
    permissionId: 'permission-abort-outbound',
    firstRunCollected,
  });
  assert.deepEqual(pendingRecords, []);

  assert.deepEqual(await adapter.abortSession({ toolSessionId: 'tool-abort-outbound' }), { applied: true });
  releaseFirstEmit.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(emittedRuns.length, 1);
  assert.deepEqual(emittedRuns[0].facts.map((fact) => fact.type), ['message.start', 'message.done']);
  assert.deepEqual(pendingRecords, []);
});

test('provider adapter abortSession overrides completed prompt while run is still draining facts', async () => {
  const prompt = createDeferred();
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-a']],
    session: {
      prompt: async () => prompt.promise,
      abort: async () => ({ data: true }),
    },
  });

  const run = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'hello',
  });

  prompt.resolve(createPromptResponse());
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(await adapter.abortSession({ toolSessionId: 'conversation-a' }), { applied: true });
  assert.deepEqual(await run.result(), { outcome: 'aborted' });
  assert.deepEqual(await collect(run.facts), []);
});

test('provider adapter tracks active runs by resolved host session id', async () => {
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    session: {
      prompt: async () => new Promise(() => undefined),
    },
  });

  await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.equal(adapter.hasActiveHostSessionRunForTest?.('host-shared'), true);
});

test('provider adapter queues prompt start under the same host session', async () => {
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    promptCount += 1;
    return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
  };

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.equal(promptCount, 1);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'host-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  firstPrompt.resolve(createPromptActionResult({ messageId: 'msg-a' }));
  assert.deepEqual(await runA.result(), { outcome: 'completed' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(promptCount, 2);
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-b',
        sessionID: 'host-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  secondPrompt.resolve(createPromptActionResult({ messageId: 'msg-b' }));
  assert.deepEqual(await runB.result(), { outcome: 'completed' });
});

test('provider adapter skips queued prompt after abortSession under the same host session', async () => {
  const firstPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    abortSessionCommandPort: {
      execute: async (input) => ({
        kind: 'aborted',
        toolSessionId: input.toolSessionId,
        hostSessionId: 'host-shared',
      }),
    },
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    promptCount += 1;
    return firstPrompt.promise;
  };

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.equal(promptCount, 1);
  assert.deepEqual(await adapter.abortSession({ toolSessionId: 'conversation-b' }), { applied: true });
  assert.deepEqual(await runA.result(), { outcome: 'aborted' });
  assert.deepEqual(await runB.result(), { outcome: 'aborted' });
  assert.equal(promptCount, 1);
});

test('provider adapter keeps aborted running prompt as host head until its task finishes', async () => {
  const firstPrompt = createDeferred();
  const thirdPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared'], ['conversation-c', 'host-shared']],
    abortSessionCommandPort: {
      execute: async (input) => ({
        kind: 'aborted',
        toolSessionId: input.toolSessionId,
        hostSessionId: 'host-shared',
      }),
    },
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    promptCount += 1;
    return promptCount === 1 ? firstPrompt.promise : thirdPrompt.promise;
  };

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.deepEqual(await adapter.abortSession({ toolSessionId: 'conversation-b' }), { applied: true });
  assert.deepEqual(await runA.result(), { outcome: 'aborted' });
  assert.deepEqual(await runB.result(), { outcome: 'aborted' });

  const runC = await adapter.runMessage({
    traceId: 'trace-c',
    runId: 'run-c',
    toolSessionId: 'conversation-c',
    text: 'third',
  });
  assert.equal(promptCount, 1);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-old',
        sessionID: 'host-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  firstPrompt.resolve(createPromptActionResult({ messageId: 'msg-old' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCount, 2);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-new',
        sessionID: 'host-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  thirdPrompt.resolve(createPromptActionResult({ messageId: 'msg-new' }));

  assert.deepEqual(await runC.result(), { outcome: 'completed' });
  const facts = await collect(runC.facts);
  assert.deepEqual(facts.map((fact) => [fact.type, fact.messageId]), [
    ['message.start', 'msg-new'],
    ['message.done', 'msg-new'],
  ]);
});

test('provider adapter cleans tracking state after aborted running prompt task finishes', async () => {
  const firstPrompt = createDeferred();
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared']],
    abortSessionCommandPort: {
      execute: async (input) => ({
        kind: 'aborted',
        toolSessionId: input.toolSessionId,
        hostSessionId: 'host-shared',
      }),
    },
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => firstPrompt.promise;

  const run = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'host-shared',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  assert.equal(adapter.hasAssistantMessageTrackingSession('host-shared'), true);

  assert.deepEqual(await adapter.abortSession({ toolSessionId: 'conversation-a' }), { applied: true });
  assert.deepEqual(await run.result(), { outcome: 'aborted' });

  firstPrompt.resolve(createPromptActionResult({ messageId: 'msg-a' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(adapter.hasAssistantMessageTrackingSession('host-shared'), false);
});

test('provider adapter skips queued prompt after closeSession for the queued anchor', async () => {
  const firstPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    closeSessionCommandPort: {
      execute: async () => ({ kind: 'closed', sessionId: 'host-shared' }),
    },
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    promptCount += 1;
    return firstPrompt.promise;
  };

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.deepEqual(await adapter.closeSession({ toolSessionId: 'conversation-b' }), { applied: true });
  assert.deepEqual(await runB.result(), { outcome: 'aborted' });
  assert.equal(promptCount, 1);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'host-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  firstPrompt.resolve(createPromptActionResult({ messageId: 'msg-a' }));
  assert.deepEqual(await runA.result(), { outcome: 'completed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCount, 1);
});

test('provider adapter starts prompts concurrently for different host sessions', async () => {
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-a'], ['conversation-b', 'host-b']],
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    promptCount += 1;
    return new Promise(() => undefined);
  };

  await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.equal(promptCount, 2);
});

test('provider adapter supersedes queued run without starting its prompt', async () => {
  const firstPrompt = createDeferred();
  const thirdPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    promptCount += 1;
    return promptCount === 1 ? firstPrompt.promise : thirdPrompt.promise;
  };

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });
  const runC = await adapter.runMessage({
    traceId: 'trace-c',
    runId: 'run-c',
    toolSessionId: 'conversation-b',
    text: 'third',
  });

  assert.deepEqual(await runB.result(), { outcome: 'aborted' });
  assert.equal(promptCount, 1);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'host-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  firstPrompt.resolve(createPromptActionResult({ messageId: 'msg-a' }));
  assert.deepEqual(await runA.result(), { outcome: 'completed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCount, 2);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-c',
        sessionID: 'host-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  thirdPrompt.resolve(createPromptActionResult({ messageId: 'msg-c' }));
  assert.deepEqual(await runC.result(), { outcome: 'completed' });
});

test('provider adapter keeps superseded running prompt as host head until its task finishes', async () => {
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared']],
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    promptCount += 1;
    return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
  };

  const firstRun = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const secondRun = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-a',
    text: 'second',
  });

  assert.deepEqual(await firstRun.result(), { outcome: 'aborted' });
  assert.equal(promptCount, 1);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-old',
        sessionID: 'host-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  firstPrompt.resolve(createPromptActionResult({ messageId: 'msg-old' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCount, 2);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-new',
        sessionID: 'host-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  secondPrompt.resolve(createPromptActionResult({ messageId: 'msg-new' }));

  assert.deepEqual(await secondRun.result(), { outcome: 'completed' });
  const facts = await collect(secondRun.facts);
  assert.deepEqual(facts.map((fact) => [fact.type, fact.messageId]), [
    ['message.start', 'msg-new'],
    ['message.done', 'msg-new'],
  ]);
});

test('provider adapter clears superseded host tracking state after old prompt task finishes', async () => {
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  let preprocessCount = 0;
  let promptCount = 0;
  const adapter = createAdapter({
    chatPreprocessor: {
      preprocess: async () => {
        preprocessCount += 1;
        return {
          kind: 'normal_chat',
          context: {
            opencodeSessionId: preprocessCount === 1 ? 'host-old' : 'host-new',
            bootstrapSource: 'existing_binding',
          },
        };
      },
    },
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    promptCount += 1;
    return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
  };

  const firstRun = await adapter.runMessage({
    traceId: 'trace-old-host',
    runId: 'run-old-host',
    toolSessionId: 'conversation-reused',
    text: 'first',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-old-host',
        sessionID: 'host-old',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  assert.equal(adapter.hasAssistantMessageTrackingSession('host-old'), true);

  await adapter.runMessage({
    traceId: 'trace-new-host',
    runId: 'run-new-host',
    toolSessionId: 'conversation-reused',
    text: 'second',
  });
  assert.deepEqual(await firstRun.result(), { outcome: 'aborted' });

  firstPrompt.resolve(createPromptActionResult({ messageId: 'msg-old-host' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(adapter.hasAssistantMessageTrackingSession('host-old'), false);
});

test('provider adapter starts next queued prompt after current prompt failure closes', async () => {
  const secondPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    promptCount += 1;
    if (promptCount === 1) {
      return {
        success: false,
        errorCode: 'SDK_UNREACHABLE',
        errorMessage: 'Failed to send message: boom',
        errorEvidence: { sourceOperation: 'session.prompt' },
      };
    }
    return secondPrompt.promise;
  };

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.deepEqual(await runA.result(), {
    outcome: 'failed',
    error: {
      code: 'provider_unavailable',
      message: 'Failed to send message: boom',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCount, 2);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-b',
        sessionID: 'host-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  secondPrompt.resolve(createPromptActionResult({ messageId: 'msg-b' }));
  assert.deepEqual(await runB.result(), { outcome: 'completed' });
});

test('provider adapter routes shared host streaming events to fifo head despite later attached owner', async () => {
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared']],
    session: {
      prompt: async () => {
        promptCount += 1;
        return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
      },
    },
  });

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });

  adapter.contextResolver.dependencies.bindingStore.bind('conversation-b', 'host-shared');
  adapter.contextResolver.dependencies.ownershipResolver.attach('host-shared', 'conversation-b');
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'host-shared',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  firstPrompt.resolve(createPromptResponse({ info: { id: 'msg-a' } }));
  const factsA = await collect(runA.facts);
  assert.equal(factsA.some((fact) => fact.type === 'message.start'), true);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-b',
        sessionID: 'host-shared',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  secondPrompt.resolve(createPromptResponse({ info: { id: 'msg-b' } }));
  const factsB = await collect(runB.facts);
  assert.equal(factsB.some((fact) => fact.type === 'message.start'), true);
});

test('provider adapter keeps active run routing when attached owner is missing during event', async () => {
  const prompt = createDeferred();
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-a']],
    session: {
      prompt: async () => prompt.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'hello',
  });

  adapter.contextResolver.dependencies.ownershipResolver.detach('host-a');

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'host-a',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  prompt.resolve(createPromptResponse({ info: { id: 'msg-a' } }));

  const facts = await collect(run.facts);
  assert.equal(facts.some((fact) => fact.type === 'message.start'), true);
});

test('provider adapter routes subagent child event through parent host fifo head with child tracking', async () => {
  const prompt = createDeferred();
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-parent']],
    session: {
      prompt: async () => prompt.promise,
      get: async (input) => ({
        data: {
          id: input?.sessionID,
          parentID: input?.sessionID === 'host-child' ? 'host-parent' : undefined,
          title: input?.sessionID === 'host-child' ? 'worker' : 'parent',
          directory: '/workspace/test',
        },
      }),
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-child',
        sessionID: 'host-child',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  prompt.resolve(createPromptResponse({ info: { id: 'msg-child' } }));

  const facts = await collect(run.facts);
  assert.equal(facts.some((fact) => fact.type === 'message.start'), true);
  assert.equal(adapter.hasAssistantMessageTrackingSession('host-child'), false);
});

test('provider adapter drops assistant streaming event when no active host run exists', async () => {
  const logs = [];
  const adapter = createAdapter({
    logger: createCapturingLogger(logs),
    bindings: [['conversation-a', 'host-a']],
  });

  assert.equal(await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-orphan',
        sessionID: 'host-a',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  }), false);
});

test('provider adapter routes session.error to outbound run when no active host run exists', async () => {
  const outboundRuns = [];
  const outboundRunCollected = createDeferred();
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-a']],
  });
  await adapter.initialize({
    outbound: {
      emitOutboundMessage: async () => {
        throw new Error('unexpected outbound message call');
      },
      emitOutboundRun: async (input) => {
        const facts = await collect(input.facts);
        outboundRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        outboundRunCollected.resolve();
        return { applied: true };
      },
    },
  });

  assert.equal(await adapter.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'host-a',
      error: { message: 'boom' },
    },
  }), true);
  await withTimeout(outboundRunCollected.promise, 'expected session.error outbound run to close');
  assert.equal(outboundRuns[0].toolSessionId, 'conversation-a');
  assert.deepEqual(outboundRuns[0].facts.map((fact) => fact.type), ['session.error']);
});

test('provider adapter routes session.error to legacy outbound message when outbound run is unavailable', async () => {
  const outboundCalls = [];
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-a']],
  });
  await adapter.initialize({
    outbound: {
      emitOutboundMessage: async (input) => {
        outboundCalls.push({
          toolSessionId: input.toolSessionId,
          messageId: input.messageId,
          facts: await collect(input.facts),
        });
      },
    },
  });

  assert.equal(await adapter.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'host-a',
      error: { message: 'boom' },
    },
  }), true);
  assert.equal(outboundCalls[0].toolSessionId, 'conversation-a');
  assert.deepEqual(outboundCalls[0].facts.map((fact) => fact.type), ['session.error']);
});

test('provider adapter routes session.error to active host run before outbound fallback', async () => {
  const outboundCalls = [];
  const prompt = createDeferred();
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-a']],
    session: {
      prompt: async () => prompt.promise,
    },
  });
  await adapter.initialize({
    outbound: {
      emitOutboundMessage: async (input) => outboundCalls.push(input),
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'host-a',
      error: { message: 'boom' },
    },
  });
  prompt.resolve(createPromptResponse());

  const facts = await collect(run.facts);
  assert.equal(facts.some((fact) => fact.type === 'session.error'), true);
  assert.deepEqual(outboundCalls, []);
});

test('provider adapter aborts all host runs when prompt terminal is aborted', async () => {
  let promptCount = 0;
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    session: {
      prompt: async () => {
        promptCount += 1;
        return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
      },
    },
  });

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  firstPrompt.resolve(createPromptResponse({
    info: {
      error: {
        name: 'MessageAbortedError',
        data: { message: 'User aborted' },
      },
    },
  }));

  assert.deepEqual(await runA.result(), { outcome: 'aborted' });
  assert.deepEqual(await runB.result(), { outcome: 'aborted' });
});

test('provider adapter completed terminal only advances fifo head for current run', async () => {
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    session: {
      prompt: async () => {
        promptCount += 1;
        return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
      },
    },
  });

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'host-shared',
        role: 'assistant',
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        finish: 'stop',
      },
    },
  });
  firstPrompt.resolve(createPromptResponse({ info: { id: 'msg-a' } }));
  await runA.result();

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-b',
        sessionID: 'host-shared',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  secondPrompt.resolve(createPromptResponse({ info: { id: 'msg-b' } }));
  const factsB = await collect(runB.facts);
  assert.equal(factsB.some((fact) => fact.type === 'message.start'), true);
});

test('provider adapter observes raw host events through session-isolation port without changing routing result', async () => {
  const observed = [];
  const adapter = createAdapter({
    hostEventPort: {
      handle: async (event) => {
        observed.push(event.type);
        return { kind: 'ignored', reason: 'unowned_event' };
      },
    },
  });

  const handled = await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'detached-session',
        id: 'msg-detached',
        role: 'assistant',
        time: {
          completed: '2026-05-22T12:00:01.000Z',
        },
      },
    },
  });

  assert.equal(handled, false);
  assert.deepEqual(observed, ['message.updated']);
});

test('provider adapter keeps active run routing when session-isolation host event observer fails', async () => {
  const warnings = [];
  const logger = {
    ...createLogger(),
    warn: (message, extra) => warnings.push({ message, extra }),
    child: () => logger,
  };
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    logger,
    bindings: [['tool-observer-failure', 'tool-observer-failure']],
    hostEventPort: {
      handle: async () => {
        throw new Error('observer failed');
      },
    },
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-observer-failure',
    runId: 'run-observer-failure',
    toolSessionId: 'tool-observer-failure',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-observer-failure',
        id: 'msg-observer-failure',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-observer-failure',
        id: 'msg-observer-failure',
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

  assert.deepEqual(facts.map((fact) => fact.type), ['message.start', 'message.done']);
  assert.deepEqual(warnings.filter((entry) => entry.message === 'provider_adapter.session_isolation_event_observer_failed'), [{
    message: 'provider_adapter.session_isolation_event_observer_failed',
    extra: {
      eventType: 'message.updated',
      error: 'observer failed',
    },
  }, {
    message: 'provider_adapter.session_isolation_event_observer_failed',
    extra: {
      eventType: 'message.updated',
      error: 'observer failed',
    },
  }]);
});

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

  const result = await adapter.createSession({
    traceId: 'trace-identity-session',
    title: 'Identity Session',
  });

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

test('provider adapter createSession delegates creation and ownership to session-isolation command port', async () => {
  const calls = [];
  const logs = [];
  const adapter = createAdapter({
    logger: createCapturingLogger(logs),
    hostDirectory: '/workspace/formal-create',
    createSessionCommandPort: {
      execute: async (input) => {
        calls.push(input);
        return {
          kind: 'entry_owned',
          toolSessionId: 'ses-formal-create',
          session: { id: 'ses-formal-create', title: 'Formal Session' },
        };
      },
    },
  });

  const result = await adapter.createSession({
    traceId: 'trace-create-formal',
    title: 'Formal Session',
    assistantId: 'assistant-formal',
    extParameters: { platformExtParam: { businessSessionDomain: 'im', businessSessionType: 'single', businessSessionId: 'u-1' } },
  });

  assert.deepEqual(result, {
    toolSessionId: 'ses-formal-create',
    title: 'Formal Session',
  });
  assert.deepEqual(calls, [{
    title: 'Formal Session',
    assistantId: 'assistant-formal',
    directory: '/workspace/test',
    extParameters: { platformExtParam: { businessSessionDomain: 'im', businessSessionType: 'single', businessSessionId: 'u-1' } },
  }]);
  assert.deepEqual(logs.filter((entry) => entry.message === 'runtime_sdk.provider.createSession.session_isolation_resolved'), [{
    level: 'info',
    message: 'runtime_sdk.provider.createSession.session_isolation_resolved',
    extra: {
      resultKind: 'entry_owned',
      toolSessionId: 'ses-formal-create',
      hasExtParameters: true,
      hasPlatformBusinessSessionId: true,
    },
  }]);
});

test('provider adapter createSession logs anchor-only session-isolation result when business id is absent', async () => {
  const logs = [];
  const adapter = createAdapter({
    logger: createCapturingLogger(logs),
    createSessionCommandPort: {
      execute: async () => ({
        kind: 'anchor_only',
        toolSessionId: 'ses_0123456789abcdef0123456789abcdef',
      }),
    },
  });

  const result = await adapter.createSession({
    traceId: 'trace-create-anchor-only',
    extParameters: {
      platformExtParam: {
        businessSessionDomain: 'miniapp',
        businessSessionType: 'direct',
        businessSessionId: null,
      },
    },
  });

  assert.deepEqual(result, {
    toolSessionId: 'ses_0123456789abcdef0123456789abcdef',
  });
  assert.deepEqual(logs.filter((entry) => entry.message === 'runtime_sdk.provider.createSession.session_isolation_resolved'), [{
    level: 'info',
    message: 'runtime_sdk.provider.createSession.session_isolation_resolved',
    extra: {
      resultKind: 'anchor_only',
      toolSessionId: 'ses_0123456789abcdef0123456789abcdef',
      hasExtParameters: true,
      hasPlatformBusinessSessionId: false,
    },
  }]);
});

test('provider adapter maps tool parts using part.tool and records diagnostics when tool name is missing', async () => {
  const warnings = [];
  const logger = {
    ...createLogger(),
    warn: (message, extra) => warnings.push({ message, extra }),
    child: () => logger,
  };
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    logger,
    bindings: [['tool-tool-update', 'tool-tool-update']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-tool-update',
    runId: 'run-tool-update',
    toolSessionId: 'tool-tool-update',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-tool-update',
        id: 'msg-tool-update',
        role: 'assistant',
        time: {
          created: '2026-05-27T12:00:00.000Z',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-tool-update',
        sessionID: 'tool-tool-update',
        messageID: 'msg-tool-update',
        type: 'tool',
        tool: 'read_file',
        callID: 'call-read-file',
        state: {
          status: 'running',
          title: '读取文件',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-tool-update-missing-name',
        sessionID: 'tool-tool-update',
        messageID: 'msg-tool-update',
        type: 'tool',
        callID: 'call-missing-name',
        state: {
          status: 'completed',
          title: '标题不能当工具名',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-tool-update',
        id: 'msg-tool-update',
        role: 'assistant',
        time: {
          created: '2026-05-27T12:00:00.000Z',
          completed: '2026-05-27T12:00:01.000Z',
        },
        finish: 'stop',
      },
    },
  });

  promptDeferred.resolve(createPromptResponse());
  const facts = await collect(run.facts);
  const toolFacts = facts.filter((fact) => fact.type === 'tool.update');

  assert.deepEqual(toolFacts, [
    {
      type: 'tool.update',
      messageId: 'msg-tool-update',
      partId: 'part-tool-update',
      toolCallId: 'call-read-file',
      toolName: 'read_file',
      status: 'running',
      title: '读取文件',
      raw: {
        part: {
          id: 'part-tool-update',
          sessionID: 'tool-tool-update',
          messageID: 'msg-tool-update',
          type: 'tool',
          tool: 'read_file',
          callID: 'call-read-file',
          state: {
            status: 'running',
            title: '读取文件',
          },
        },
      },
    },
    {
      type: 'tool.update',
      messageId: 'msg-tool-update',
      partId: 'part-tool-update-missing-name',
      toolCallId: 'call-missing-name',
      toolName: 'tool',
      status: 'completed',
      title: '标题不能当工具名',
      raw: {
        part: {
          id: 'part-tool-update-missing-name',
          sessionID: 'tool-tool-update',
          messageID: 'msg-tool-update',
          type: 'tool',
          callID: 'call-missing-name',
          state: {
            status: 'completed',
            title: '标题不能当工具名',
          },
        },
      },
    },
  ]);
  assert.deepEqual(warnings, [{
    message: 'provider_adapter.protocol_diagnostic',
    extra: {
      code: 'tool_update_missing_tool_name',
      toolSessionId: 'tool-tool-update',
      messageId: 'msg-tool-update',
      partId: 'part-tool-update-missing-name',
      partType: 'tool',
    },
  }]);
});

test('provider adapter closeSession delegates cleanup to session-isolation command port', async () => {
  const calls = [];
  const adapter = createAdapter({
    bindings: [['tool-close-formal', 'ses-close-formal']],
    closeSessionCommandPort: {
      execute: async (input) => {
        calls.push(input);
        return { kind: 'closed', sessionId: 'ses-close-formal' };
      },
    },
    session: {
      delete: async () => {
        throw new Error('legacy_close_should_not_be_called');
      },
    },
  });

  assert.deepEqual(await adapter.closeSession({
    traceId: 'trace-close-formal',
    toolSessionId: 'tool-close-formal',
  }), { applied: true });
  assert.deepEqual(calls, [{ toolSessionId: 'tool-close-formal' }]);
});

test('provider adapter closeSession clears queued TUI outbound run events for closed host session', async () => {
  const emittedRuns = [];
  const pendingRecords = [];
  const firstRunCollected = createDeferred();
  const releaseFirstEmit = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-close-outbound', 'ses-close-outbound']],
    pendingInteractionRecorder: {
      record: (input) => pendingRecords.push(input),
    },
    closeSessionCommandPort: {
      execute: async () => ({ kind: 'closed', sessionId: 'ses-close-outbound' }),
    },
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        emittedRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        firstRunCollected.resolve();
        await releaseFirstEmit.promise;
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'ses-close-outbound',
        id: 'msg-close-outbound',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'ses-close-outbound',
        id: 'msg-close-outbound',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:01.000Z' },
        finish: 'stop',
      },
    },
  });
  await withTimeout(firstRunCollected.promise, 'expected first outbound run to reach emission');

  await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'ses-close-outbound',
      id: 'permission-close-outbound',
      permission: 'shell',
      tool: {
        messageID: 'msg-close-outbound-queued',
      },
    },
  });
  assert.deepEqual(pendingRecords, []);

  assert.deepEqual(await adapter.closeSession({ toolSessionId: 'tool-close-outbound' }), { applied: true });
  releaseFirstEmit.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(emittedRuns.length, 1);
  assert.deepEqual(emittedRuns[0].facts.map((fact) => fact.type), ['message.start', 'message.done']);
  assert.deepEqual(pendingRecords, []);
});

test('provider adapter closeSession legacy fallback clears queued TUI outbound run events', async () => {
  const emittedRuns = [];
  const pendingRecords = [];
  const closeCalls = [];
  const firstRunCollected = createDeferred();
  const releaseFirstEmit = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-close-legacy-outbound', 'ses-close-legacy-outbound']],
    pendingInteractionRecorder: {
      record: (input) => pendingRecords.push(input),
    },
    session: {
      delete: async (input) => {
        closeCalls.push(input);
        return { data: true };
      },
    },
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        emittedRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        firstRunCollected.resolve();
        await releaseFirstEmit.promise;
        return { applied: true };
      },
    },
  });

  await queuePermissionBehindBlockedTuiOutboundRun(adapter, {
    hostSessionId: 'ses-close-legacy-outbound',
    messageId: 'msg-close-legacy-outbound',
    queuedMessageId: 'msg-close-legacy-outbound-queued',
    permissionId: 'permission-close-legacy-outbound',
    firstRunCollected,
  });
  assert.deepEqual(pendingRecords, []);

  assert.deepEqual(await adapter.closeSession({ toolSessionId: 'tool-close-legacy-outbound' }), { applied: true });
  releaseFirstEmit.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closeCalls.length, 1);
  assert.equal(emittedRuns.length, 1);
  assert.deepEqual(emittedRuns[0].facts.map((fact) => fact.type), ['message.start', 'message.done']);
  assert.deepEqual(pendingRecords, []);
});

test('provider adapter maps missing business entry to invalid_input failed run', async () => {
  const adapter = createAdapter({
    chatPreprocessor: {
      preprocess: async () => {
        throw new Error('business_entry_key_required');
      },
    },
  });

  const run = await adapter.runMessage({
    traceId: 'trace-missing-entry',
    runId: 'run-missing-entry',
    toolSessionId: 'tool-missing-entry',
    text: 'hello',
    extParameters: {},
  });

  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'invalid_input',
      message: 'business_entry_key_required',
    },
  });
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

test('provider adapter emits thinking.done only after reasoning part has time.end', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-thinking', 'tool-thinking']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-thinking',
    runId: 'run-thinking',
    toolSessionId: 'tool-thinking',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-thinking',
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
        id: 'part-thinking-1',
        sessionID: 'tool-thinking',
        messageID: 'msg-1',
        type: 'reasoning',
        text: '',
        time: {
          start: '2026-05-22T12:00:00.100Z',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: 'tool-thinking',
      messageID: 'msg-1',
      partID: 'part-thinking-1',
      field: 'text',
      delta: 'first thought',
    },
  });
  await adapter.handleEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-thinking-1',
        sessionID: 'tool-thinking',
        messageID: 'msg-1',
        type: 'reasoning',
        text: 'first thought',
        time: {
          start: '2026-05-22T12:00:00.100Z',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-thinking-2',
        sessionID: 'tool-thinking',
        messageID: 'msg-1',
        type: 'reasoning',
        text: '',
        time: {
          start: '2026-05-22T12:00:00.200Z',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: 'tool-thinking',
      messageID: 'msg-1',
      partID: 'part-thinking-2',
      field: 'text',
      delta: 'second thought',
    },
  });
  await adapter.handleEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-thinking-1',
        sessionID: 'tool-thinking',
        messageID: 'msg-1',
        type: 'reasoning',
        text: 'first thought complete',
        time: {
          start: '2026-05-22T12:00:00.100Z',
          end: '2026-05-22T12:00:00.300Z',
        },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-thinking',
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

  promptDeferred.resolve(createPromptResponse());
  const facts = await collect(run.facts);

  assert.deepEqual(facts, [
    {
      type: 'message.start',
      messageId: 'msg-1',
      raw: {
        info: {
          sessionID: 'tool-thinking',
          id: 'msg-1',
          role: 'assistant',
          time: {
            created: '2026-05-22T12:00:00.000Z',
          },
        },
      },
    },
    {
      type: 'thinking.delta',
      messageId: 'msg-1',
      partId: 'part-thinking-1',
      content: 'first thought',
      raw: {
        sessionID: 'tool-thinking',
        messageID: 'msg-1',
        partID: 'part-thinking-1',
        field: 'text',
        delta: 'first thought',
      },
    },
    {
      type: 'thinking.delta',
      messageId: 'msg-1',
      partId: 'part-thinking-2',
      content: 'second thought',
      raw: {
        sessionID: 'tool-thinking',
        messageID: 'msg-1',
        partID: 'part-thinking-2',
        field: 'text',
        delta: 'second thought',
      },
    },
    {
      type: 'thinking.done',
      messageId: 'msg-1',
      partId: 'part-thinking-1',
      content: 'first thought complete',
      raw: {
        part: {
          id: 'part-thinking-1',
          sessionID: 'tool-thinking',
          messageID: 'msg-1',
          type: 'reasoning',
          text: 'first thought complete',
          time: {
            start: '2026-05-22T12:00:00.100Z',
            end: '2026-05-22T12:00:00.300Z',
          },
        },
      },
    },
    {
      type: 'message.done',
      messageId: 'msg-1',
      reason: 'stop',
      raw: {
        info: {
          sessionID: 'tool-thinking',
          id: 'msg-1',
          role: 'assistant',
          time: {
            created: '2026-05-22T12:00:00.000Z',
            completed: '2026-05-22T12:00:01.000Z',
          },
          finish: 'stop',
        },
      },
    },
  ]);
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
  assert.equal(infos[2].extra.providerOutcome, 'completed');
  assert.equal(typeof infos[2].extra.durationMs, 'number');
});

test('provider adapter logs immediate failed run when preprocess rejects', async () => {
  const warnings = [];
  const logger = {
    ...createLogger(),
    warn: (message, extra) => warnings.push({ message, extra }),
    child: () => logger,
  };
  const adapter = createAdapter({
    logger,
    chatPreprocessor: {
      preprocess: async () => {
        throw new Error('business_entry_key_required');
      },
    },
  });

  const run = await adapter.runMessage({
    traceId: 'trace-immediate-failed',
    runId: 'run-immediate-failed',
    toolSessionId: 'tool-immediate-failed',
    text: 'hello',
  });

  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'invalid_input',
      message: 'business_entry_key_required',
    },
  });
  assert.deepEqual(warnings[0], {
    message: 'provider_adapter.run.immediate_failed',
    extra: {
      toolSessionId: 'tool-immediate-failed',
      runId: 'run-immediate-failed',
      providerOutcome: 'failed',
      mappedProviderErrorCode: 'invalid_input',
      error: 'business_entry_key_required',
      failureStage: 'preprocess',
    },
  });
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

test('provider adapter records subagent pending interactions against parent host session', async () => {
  const promptDeferred = createDeferred();
  const pendingInteractions = [];
  const adapter = createAdapter({
    bindings: [['ses-parent-pending-1', 'ses-parent-pending-1']],
    pendingInteractionRecorder: {
      record: (interaction) => pendingInteractions.push(interaction),
    },
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-subagent-pending',
    runId: 'run-subagent-pending',
    toolSessionId: 'ses-parent-pending-1',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'session.created',
    properties: {
      info: {
        id: 'ses-child-pending-1',
        parentID: 'ses-parent-pending-1',
        title: 'research-agent',
      },
    },
  });
  await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'ses-child-pending-1',
      id: 'perm-child-pending-1',
      permission: 'shell',
      tool: {
        messageID: 'msg-child-permission-1',
        callID: 'call-child-permission-1',
      },
    },
  });

  promptDeferred.resolve(createPromptResponse());
  const facts = await collect(run.facts);

  assert.equal(facts.some((fact) => fact.type === 'permission.ask'), true);
  assert.deepEqual(pendingInteractions, [{
    kind: 'permission',
    tokenId: 'perm-child-pending-1',
    toolSessionId: 'ses-parent-pending-1',
    hostSessionId: 'ses-parent-pending-1',
  }]);
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
      permission: 'shell',
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

test('provider adapter maps permission.asked permission field and legacy type fallback', async () => {
  const promptDeferred = createDeferred();
  const pendingInteractions = [];
  const adapter = createAdapter({
    bindings: [['tool-permission', 'tool-permission']],
    pendingInteractionRecorder: {
      record: (interaction) => pendingInteractions.push(interaction),
    },
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
      permission: 'file_write',
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
      type: 'shell',
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
    permType: 'file_write',
    metadata: {
      scope: 'workspace',
    },
    raw: {
      sessionID: 'tool-permission',
      id: 'perm-1',
      permission: 'file_write',
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
      permType: 'shell',
      metadata: {
        scope: 'fallback',
      },
      raw: {
        sessionID: 'tool-permission',
        id: 'perm-2',
        type: 'shell',
        metadata: {
          scope: 'fallback',
        },
      },
    },
  );
  assert.match(facts[1].partId, /^prt_[0-9a-f]{32}$/);
  assert.deepEqual(pendingInteractions, [
    {
      kind: 'permission',
      tokenId: 'perm-1',
      toolSessionId: 'tool-permission',
      hostSessionId: 'tool-permission',
    },
    {
      kind: 'permission',
      tokenId: 'perm-2',
      toolSessionId: 'tool-permission',
      hostSessionId: 'tool-permission',
    },
  ]);
});

test('provider adapter drops permission.asked when neither permission nor legacy type exists', async () => {
  const warnings = [];
  const logger = {
    ...createLogger(),
    warn: (message, extra) => warnings.push({ message, extra }),
    child: () => logger,
  };
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    logger,
    bindings: [['tool-permission-missing-type', 'tool-permission-missing-type']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-permission-missing-type',
    runId: 'run-permission-missing-type',
    toolSessionId: 'tool-permission-missing-type',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'tool-permission-missing-type',
      id: 'perm-missing-type',
    },
  });

  promptDeferred.resolve(createPromptResponse());
  const facts = await collect(run.facts);

  assert.deepEqual(facts, []);
  assert.equal(warnings.some((entry) => entry.message === 'provider_adapter.protocol_diagnostic'
    && entry.extra?.code === 'permission_ask_missing_perm_type'
    && entry.extra?.toolSessionId === 'tool-permission-missing-type'
    && entry.extra?.permissionId === 'perm-missing-type'), true);
});

test('provider adapter maps question.asked multiple to question.ask multiSelect', async () => {
  const promptDeferred = createDeferred();
  const pendingInteractions = [];
  const adapter = createAdapter({
    bindings: [['tool-question', 'tool-question']],
    pendingInteractionRecorder: {
      record: (interaction) => pendingInteractions.push(interaction),
    },
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
            { label: 'A', description: 'First option' },
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
            { label: 'A', description: 'First option' },
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
              { label: 'A', description: 'First option' },
              { label: 'B' },
            ],
          },
        ],
      },
    },
  ]);
  assert.deepEqual(pendingInteractions, [{
    kind: 'question',
    tokenId: 'question-1',
    toolSessionId: 'tool-question',
    hostSessionId: 'tool-question',
  }]);
});

test('provider adapter drops malformed question options without required label', async () => {
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-question-label', 'tool-question-label']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-question-label',
    runId: 'run-question-label',
    toolSessionId: 'tool-question-label',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-question-label',
        id: 'msg-label-1',
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
      sessionID: 'tool-question-label',
      id: 'question-label-1',
      partID: 'part-question-label-1',
      tool: {
        messageID: 'msg-label-1',
        callID: 'call-question-label-1',
      },
      questions: [
        {
          question: 'Pick one',
          options: [
            { description: 'Missing label' },
            { label: '', description: 'Empty label is preserved' },
            { label: 'A' },
          ],
        },
      ],
    },
  });

  promptDeferred.resolve(createPromptResponse());
  const facts = await collect(run.facts);

  assert.deepEqual(facts[1].questions[0].options, [
    { label: '', description: 'Empty label is preserved' },
    { label: 'A' },
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
        providerOutcome: 'failed',
        terminalErrorCode: 'internal_error',
        terminalErrorMessage: 'APIError',
        terminalErrorDetails: {
          name: 'APIError',
        },
      },
    },
  );
});

test('provider adapter logs prompt failure source evidence and mapping', async () => {
  const warnings = [];
  const logger = {
    ...createLogger(),
    warn: (message, extra) => warnings.push({ message, extra }),
    child: () => logger,
  };
  const adapter = createAdapter({
    logger,
    bindings: [['tool-prompt-failed', 'tool-prompt-failed']],
    session: {
      prompt: async () => ({
        error: {
          code: 'rate_limit',
          status: 429,
          message: 'slow down',
        },
      }),
    },
  });

  const run = await adapter.runMessage({
    traceId: 'trace-prompt-failed',
    runId: 'run-prompt-failed',
    toolSessionId: 'tool-prompt-failed',
    text: 'hello',
  });

  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'provider_unavailable',
      message: 'Failed to send message: slow down',
    },
  });
  assert.deepEqual(warnings.find((entry) => entry.message === 'provider_adapter.prompt.failed'), {
    message: 'provider_adapter.prompt.failed',
    extra: {
      toolSessionId: 'tool-prompt-failed',
      opencodeSessionId: 'tool-prompt-failed',
      runId: 'run-prompt-failed',
      durationMs: warnings.find((entry) => entry.message === 'provider_adapter.prompt.failed').extra.durationMs,
      providerOutcome: 'failed',
      mappedProviderErrorCode: 'provider_unavailable',
      error: 'Failed to send message: slow down',
      sourceOperation: 'session.prompt',
      sourceErrorCode: 'rate_limit',
      httpStatus: 429,
    },
  });
});

test('provider adapter logs thrown prompt error evidence attached on the error object', async () => {
  const errors = [];
  const logger = {
    ...createLogger(),
    error: (message, extra) => errors.push({ message, extra }),
    child: () => logger,
  };
  const adapter = createAdapter({
    logger,
    bindings: [['tool-prompt-threw', 'tool-prompt-threw']],
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    const error = new Error('prompt transport exploded');
    Object.assign(error, {
      errorEvidence: {
        sourceOperation: 'session.prompt',
        sourceErrorCode: 'transport_error',
        httpStatus: 502,
      },
    });
    throw error;
  };

  const run = await adapter.runMessage({
    traceId: 'trace-prompt-threw',
    runId: 'run-prompt-threw',
    toolSessionId: 'tool-prompt-threw',
    text: 'hello',
  });

  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'internal_error',
      message: 'prompt transport exploded',
    },
  });
  assert.deepEqual(errors.find((entry) => entry.message === 'provider_adapter.prompt.threw'), {
    message: 'provider_adapter.prompt.threw',
    extra: {
      toolSessionId: 'tool-prompt-threw',
      opencodeSessionId: 'tool-prompt-threw',
      runId: 'run-prompt-threw',
      durationMs: errors.find((entry) => entry.message === 'provider_adapter.prompt.threw').extra.durationMs,
      error: 'prompt transport exploded',
      providerOutcome: 'failed',
      mappedProviderErrorCode: 'internal_error',
      sourceOperation: 'session.prompt',
      sourceErrorCode: 'transport_error',
      httpStatus: 502,
    },
  });
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

test('provider adapter times out active run after final idle when prompt never settles', async () => {
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  const promptCalls = [];
  const adapter = createAdapter({
    finalIdleTimeoutMs: 100,
    bindings: [
      ['tool-active-final-idle-a', 'host-active-final-idle'],
      ['tool-active-final-idle-b', 'host-active-final-idle'],
    ],
  });
  adapter.opencodeSessionGatewayAdapter.promptSession = async () => {
    const deferred = promptCalls.length === 0 ? firstPrompt : secondPrompt;
    promptCalls.push(deferred);
    return deferred.promise;
  };

  const firstRun = await adapter.runMessage({
    traceId: 'trace-active-final-idle-1',
    runId: 'run-active-final-idle-1',
    toolSessionId: 'tool-active-final-idle-a',
    text: 'first',
  });
  const secondRun = await adapter.runMessage({
    traceId: 'trace-active-final-idle-2',
    runId: 'run-active-final-idle-2',
    toolSessionId: 'tool-active-final-idle-b',
    text: 'second',
  });

  assert.deepEqual(await withTimeout(firstRun.result(), 'expected first run to timeout'), {
    outcome: 'failed',
    error: {
      code: 'timeout',
      message: 'provider_run_final_idle_timeout',
      retryable: true,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCalls.length, 2);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-active-final-idle',
        id: 'msg-active-final-idle-2',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:02.000Z',
          completed: '2026-05-22T12:00:03.000Z',
        },
        finish: 'stop',
      },
    },
  });
  secondPrompt.resolve(createPromptActionResult({ messageId: 'msg-active-final-idle-2' }));

  assert.deepEqual(await secondRun.result(), { outcome: 'completed' });
});

test('provider adapter aborts superseded run without deleting the newer active run', async () => {
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  const promptCalls = [];
  const adapter = createAdapter({
    bindings: [['tool-stale-cleanup', 'tool-stale-cleanup']],
    session: {
      prompt: async () => {
        const deferred = promptCalls.length === 0 ? firstPrompt : secondPrompt;
        promptCalls.push(deferred);
        return deferred.promise;
      },
    },
  });

  const firstRun = await adapter.runMessage({
    traceId: 'trace-stale-cleanup-1',
    runId: 'run-stale-cleanup-1',
    toolSessionId: 'tool-stale-cleanup',
    text: 'first',
  });
  firstPrompt.resolve(createPromptResponse());
  await Promise.resolve();
  await Promise.resolve();

  const secondRun = await adapter.runMessage({
    traceId: 'trace-stale-cleanup-2',
    runId: 'run-stale-cleanup-2',
    toolSessionId: 'tool-stale-cleanup',
    text: 'second',
  });

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await firstRun.result(), { outcome: 'aborted' });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-stale-cleanup',
        id: 'msg-second-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:02.000Z',
          completed: '2026-05-22T12:00:03.000Z',
        },
        finish: 'stop',
      },
    },
  });
  secondPrompt.resolve(createPromptResponse());

  assert.deepEqual(await secondRun.result(), { outcome: 'completed' });
  assert.deepEqual(
    (await collect(secondRun.facts)).map((fact) => fact.type),
    ['message.start', 'message.done'],
  );
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
  const promptDeferred = createDeferred();
  const adapter = createAdapter({
    logger,
    bindings: [['tool-session-42', 'tool-session-42']],
    session: {
      prompt: async () => promptDeferred.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-routing-diagnostics',
    runId: 'run-routing-diagnostics',
    toolSessionId: 'tool-session-42',
    text: 'hello',
  });

  const handled = await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-session-42',
        id: 'msg-routing-1',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
        },
      },
    },
  });
  promptDeferred.resolve(createPromptResponse());
  await collect(run.facts);
  await run.result();

  assert.equal(handled, true);
  const received = debugs.find((entry) => entry.message === 'provider_adapter.event.received');
  const translation = debugs.find((entry) => entry.message === 'provider_adapter.event.translation');
  assert.deepEqual(received?.extra, {
    eventType: 'message.updated',
    rawSessionId: 'tool-session-42',
    anchorSessionId: 'tool-session-42',
    hasActiveRun: true,
    activeRunId: 'run-routing-diagnostics',
    hasRuntimeContext: false,
    messageId: 'msg-routing-1',
  });
  assert.deepEqual(translation?.extra, {
    eventType: 'message.updated',
    rawSessionId: 'tool-session-42',
    anchorSessionId: 'tool-session-42',
    hasActiveRun: true,
    activeRunId: 'run-routing-diagnostics',
    messageId: 'msg-routing-1',
    recognized: true,
    factTypes: ['message.start'],
  });
  assert.equal('properties' in received.extra, false);
  assert.equal('trackingSessionId' in received.extra, false);
});

test('provider adapter logs debug drop reason when event has no raw session identity', async () => {
  const logs = [];
  const adapter = createAdapter({ logger: createCapturingLogger(logs) });

  const handled = await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-missing-session',
        role: 'assistant',
      },
    },
  });

  const debugs = logs.filter((entry) => entry.level === 'debug');
  const warnings = logs.filter((entry) => entry.level === 'warn');
  const errors = logs.filter((entry) => entry.level === 'error');
  assert.equal(handled, false);
  assert.equal(warnings.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.event.dropped'
    && entry.extra?.eventType === 'message.updated'
    && entry.extra?.dropReason === 'missing_raw_session_id'), true);
});

test('provider adapter records session.created diagnostics when child session mapping is captured', async () => {
  const logs = [];
  const adapter = createAdapter({ logger: createCapturingLogger(logs) });

  const handled = await adapter.handleEvent({
    type: 'session.created',
    properties: {
      info: {
        id: 'child-session-1',
        parentID: 'host-session-1',
        title: 'subagent-1',
      },
    },
  });

  const debugs = logs.filter((entry) => entry.level === 'debug');
  const warnings = logs.filter((entry) => entry.level === 'warn');
  const errors = logs.filter((entry) => entry.level === 'error');
  assert.equal(handled, true);
  assert.equal(warnings.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.session_created_recorded'
    && entry.extra?.eventType === 'session.created'
    && entry.extra?.childSessionId === 'child-session-1'
    && entry.extra?.parentSessionId === 'host-session-1'
    && entry.extra?.agentName === 'subagent-1'), true);
});

test('provider adapter logs unsupported event before raw session identity fallback', async () => {
  const logs = [];
  const adapter = createAdapter({ logger: createCapturingLogger(logs) });

  const handled = await adapter.handleEvent({
    type: 'unknown.event',
    properties: {
      sessionID: 'host-unknown-event',
    },
  });

  const debugs = logs.filter((entry) => entry.level === 'debug');
  const warnings = logs.filter((entry) => entry.level === 'warn');
  const errors = logs.filter((entry) => entry.level === 'error');
  assert.equal(handled, false);
  assert.equal(warnings.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.event.dropped'
    && entry.extra?.eventType === 'unknown.event'
    && entry.extra?.rawSessionId === 'host-unknown-event'
    && entry.extra?.dropReason === 'unsupported_event'), true);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.event.dropped'
    && entry.extra?.dropReason === 'missing_raw_session_id'), false);
});

test('provider adapter logs debug drop reason when session.error has no runtime context', async () => {
  const logs = [];
  const adapter = createAdapter({ logger: createCapturingLogger(logs) });

  const handled = await adapter.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'host-no-runtime-context',
      error: 'boom',
    },
  });

  const debugs = logs.filter((entry) => entry.level === 'debug');
  const warnings = logs.filter((entry) => entry.level === 'warn');
  const errors = logs.filter((entry) => entry.level === 'error');
  assert.equal(handled, false);
  assert.equal(warnings.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.event.dropped'
    && entry.extra?.eventType === 'session.error'
    && entry.extra?.rawSessionId === 'host-no-runtime-context'
    && entry.extra?.dropReason === 'missing_runtime_context'), true);
});

test('provider adapter logs debug drop reason when session.error has no outbound target', async () => {
  const logs = [];
  const adapter = createAdapter({ logger: createCapturingLogger(logs) });
  await adapter.initialize({
    outbound: {
      emitOutboundMessage: async () => {
        throw new Error('unexpected outbound call');
      },
    },
  });

  const handled = await adapter.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'host-detached',
      error: 'boom',
    },
  });

  const debugs = logs.filter((entry) => entry.level === 'debug');
  const warnings = logs.filter((entry) => entry.level === 'warn');
  const errors = logs.filter((entry) => entry.level === 'error');
  assert.equal(handled, false);
  assert.equal(warnings.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.event.dropped'
    && entry.extra?.eventType === 'session.error'
    && entry.extra?.rawSessionId === 'host-detached'
    && entry.extra?.dropReason === 'missing_outbound_target'), true);
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
  const logs = [];
  const adapter = createAdapter({ logger: createCapturingLogger(logs) });

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
  const debugs = logs.filter((entry) => entry.level === 'debug');
  const warnings = logs.filter((entry) => entry.level === 'warn');
  const errors = logs.filter((entry) => entry.level === 'error');
  assert.equal(warnings.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.event.dropped'
    && entry.extra?.eventType === 'message.updated'
    && entry.extra?.rawSessionId === 'tool-session-42'
    && entry.extra?.messageId === 'msg-42'
    && entry.extra?.dropReason === 'missing_runtime_context'), true);
});

test('provider adapter routes detached TUI assistant messages through outbound run', async () => {
  const outboundRuns = [];
  const pendingRecords = [];
  const outboundRunCollected = createDeferred();
  const secondOutboundRunCollected = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-tui-outbound', 'host-tui-outbound']],
    pendingInteractionRecorder: {
      record: (input) => pendingRecords.push(input),
    },
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        outboundRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        if (outboundRuns.length === 1) {
          outboundRunCollected.resolve();
        }
        if (outboundRuns.length === 2) {
          secondOutboundRunCollected.resolve();
        }
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-outbound',
        id: 'msg-tui-1',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: 'host-tui-outbound',
      messageID: 'msg-tui-1',
      partID: 'part-tui-1',
      delta: 'hello',
    },
  });
  await adapter.handleEvent({
    type: 'question.asked',
    properties: {
      sessionID: 'host-tui-outbound',
      id: 'question-tui-1',
      tool: {
        messageID: 'msg-tui-1',
      },
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
    },
  });
  await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'host-tui-outbound',
      id: 'permission-tui-1',
      permission: 'shell',
      tool: {
        messageID: 'msg-tui-1',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-outbound',
        id: 'msg-tui-1',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:01.000Z' },
        finish: 'stop',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-outbound',
        id: 'msg-tui-2',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:02.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: 'host-tui-outbound',
      messageID: 'msg-tui-2',
      partID: 'part-tui-2',
      delta: 'again',
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-outbound',
        id: 'msg-tui-2',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:03.000Z' },
        finish: 'stop',
      },
    },
  });

  await withTimeout(outboundRunCollected.promise, 'expected outbound run to close');
  await withTimeout(secondOutboundRunCollected.promise, 'expected second outbound run to close');
  const [firstOutboundRun, secondOutboundRun] = outboundRuns;
  assert.equal(outboundRuns.length, 2);
  assert.equal(firstOutboundRun.toolSessionId, 'tool-tui-outbound');
  assert.equal(secondOutboundRun.toolSessionId, 'tool-tui-outbound');
  assert.deepEqual(firstOutboundRun.facts.map((fact) => fact.type), [
    'message.start',
    'text.delta',
    'question.ask',
    'permission.ask',
    'message.done',
  ]);
  assert.deepEqual(secondOutboundRun.facts.map((fact) => fact.type), [
    'message.start',
    'text.delta',
    'message.done',
  ]);
  assert.deepEqual(firstOutboundRun.facts.map((fact) => fact.messageId), [
    'msg-tui-1',
    'msg-tui-1',
    'msg-tui-1',
    'msg-tui-1',
    'msg-tui-1',
  ]);
  assert.deepEqual(secondOutboundRun.facts.map((fact) => fact.messageId), [
    'msg-tui-2',
    'msg-tui-2',
    'msg-tui-2',
  ]);
  assert.deepEqual(pendingRecords, [
    {
      kind: 'question',
      tokenId: 'question-tui-1',
      toolSessionId: 'tool-tui-outbound',
      hostSessionId: 'host-tui-outbound',
    },
    {
      kind: 'permission',
      tokenId: 'permission-tui-1',
      toolSessionId: 'tool-tui-outbound',
      hostSessionId: 'host-tui-outbound',
    },
  ]);
});

test('provider adapter routes detached permission.replied through outbound run', async () => {
  const outboundRuns = [];
  const outboundRunCollected = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-tui-permission-reply', 'host-tui-permission-reply']],
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        outboundRuns.push({
          toolSessionId: input.toolSessionId,
          facts,
        });
        outboundRunCollected.resolve();
        return { applied: true };
      },
    },
  });

  const handled = await adapter.handleEvent({
    type: 'permission.replied',
    properties: {
      sessionID: 'host-tui-permission-reply',
      requestID: 'permission-reply-tui-1',
      reply: 'once',
    },
  });

  assert.equal(handled, true);
  await withTimeout(outboundRunCollected.promise, 'expected permission reply outbound run to close');
  assert.equal(outboundRuns.length, 1);
  assert.equal(outboundRuns[0].toolSessionId, 'tool-tui-permission-reply');
  assert.deepEqual(outboundRuns[0].facts, [{
    type: 'permission.reply',
    permissionId: 'permission-reply-tui-1',
    response: 'once',
    raw: {
      sessionID: 'host-tui-permission-reply',
      requestID: 'permission-reply-tui-1',
      reply: 'once',
    },
  }]);
});

test('provider adapter buffers outbound handoff until previous emitOutboundRun settles', async () => {
  const outboundRuns = [];
  const firstRunCollected = createDeferred();
  const secondRunCollected = createDeferred();
  const releaseFirstEmit = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-tui-closed-window', 'host-tui-closed-window']],
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        outboundRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        if (outboundRuns.length === 1) {
          firstRunCollected.resolve();
          await releaseFirstEmit.promise;
        } else {
          secondRunCollected.resolve();
        }
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-closed-window',
        id: 'msg-window-1',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-closed-window',
        id: 'msg-window-1',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:01.000Z' },
        finish: 'stop',
      },
    },
  });
  await withTimeout(firstRunCollected.promise, 'expected first outbound run to close');

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-closed-window',
        id: 'msg-window-2',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:02.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-closed-window',
        id: 'msg-window-2',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:03.000Z' },
        finish: 'stop',
      },
    },
  });

  await assert.rejects(
    () => withTimeout(secondRunCollected.promise, 'second outbound run should wait for first emit to settle', 80),
    /second outbound run should wait for first emit to settle/,
  );
  releaseFirstEmit.resolve();
  await withTimeout(secondRunCollected.promise, 'expected buffered outbound run to close after first emit settles');
  assert.equal(outboundRuns.length, 2);
  assert.deepEqual(outboundRuns.map((run) => run.facts.map((fact) => fact.messageId)), [
    ['msg-window-1', 'msg-window-1'],
    ['msg-window-2', 'msg-window-2'],
  ]);
});

test('provider adapter records queued interaction with accepted anchor while handoff run stays open', async () => {
  const outboundRuns = [];
  const pendingRecords = [];
  const firstRunCollected = createDeferred();
  const secondRunCollected = createDeferred();
  const releaseFirstEmit = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-tui-handoff-a', 'host-tui-handoff-anchor']],
    pendingInteractionRecorder: {
      record: (input) => pendingRecords.push(input),
    },
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        outboundRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        if (outboundRuns.length === 1) {
          firstRunCollected.resolve();
          await releaseFirstEmit.promise;
        } else {
          secondRunCollected.resolve();
        }
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-handoff-anchor',
        id: 'msg-handoff-old',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-handoff-anchor',
        id: 'msg-handoff-old',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:01.000Z' },
        finish: 'stop',
      },
    },
  });
  await withTimeout(firstRunCollected.promise, 'expected first outbound run to close');

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-handoff-anchor',
        id: 'msg-handoff-a-open',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:02.000Z' },
      },
    },
  });

  adapter.contextResolver.dependencies.ownershipResolver.attach('host-tui-handoff-anchor', 'tool-tui-handoff-b');

  await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'host-tui-handoff-anchor',
      id: 'permission-handoff-b-joins-a',
      permission: 'shell',
      tool: {
        messageID: 'msg-handoff-a-open',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-handoff-anchor',
        id: 'msg-handoff-a-open',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:03.000Z' },
        finish: 'stop',
      },
    },
  });

  releaseFirstEmit.resolve();
  await withTimeout(secondRunCollected.promise, 'expected queued open run to flush');

  assert.equal(outboundRuns.length, 2);
  assert.equal(outboundRuns[1].toolSessionId, 'tool-tui-handoff-a');
  assert.deepEqual(outboundRuns[1].facts.map((fact) => [fact.type, fact.messageId]), [
    ['message.start', 'msg-handoff-a-open'],
    ['permission.ask', 'msg-handoff-a-open'],
    ['message.done', 'msg-handoff-a-open'],
  ]);
  assert.deepEqual(pendingRecords, [{
    kind: 'permission',
    tokenId: 'permission-handoff-b-joins-a',
    toolSessionId: 'tool-tui-handoff-a',
    hostSessionId: 'host-tui-handoff-anchor',
  }]);
});

test('provider adapter records queued interaction with next owner after handoff run closes', async () => {
  const outboundRuns = [];
  const pendingRecords = [];
  const firstRunCollected = createDeferred();
  const thirdRunCollected = createDeferred();
  const releaseFirstEmit = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-tui-handoff-a-closed', 'host-tui-handoff-anchor-closed']],
    pendingInteractionRecorder: {
      record: (input) => pendingRecords.push(input),
    },
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        outboundRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        if (outboundRuns.length === 1) {
          firstRunCollected.resolve();
          await releaseFirstEmit.promise;
        }
        if (outboundRuns.length === 3) {
          thirdRunCollected.resolve();
        }
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-handoff-anchor-closed',
        id: 'msg-handoff-closed-old',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-handoff-anchor-closed',
        id: 'msg-handoff-closed-old',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:01.000Z' },
        finish: 'stop',
      },
    },
  });
  await withTimeout(firstRunCollected.promise, 'expected first outbound run to close');

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-handoff-anchor-closed',
        id: 'msg-handoff-a-closed',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:02.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-handoff-anchor-closed',
        id: 'msg-handoff-a-closed',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:03.000Z' },
        finish: 'stop',
      },
    },
  });

  adapter.contextResolver.dependencies.ownershipResolver.attach('host-tui-handoff-anchor-closed', 'tool-tui-handoff-b-closed');

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-handoff-anchor-closed',
        id: 'msg-handoff-b-open',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:04.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'host-tui-handoff-anchor-closed',
      id: 'permission-handoff-b-new-run',
      permission: 'shell',
      tool: {
        messageID: 'msg-handoff-b-open',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-handoff-anchor-closed',
        id: 'msg-handoff-b-open',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:05.000Z' },
        finish: 'stop',
      },
    },
  });

  releaseFirstEmit.resolve();
  await withTimeout(thirdRunCollected.promise, 'expected queued next-owner run to flush');

  assert.equal(outboundRuns.length, 3);
  assert.equal(outboundRuns[1].toolSessionId, 'tool-tui-handoff-a-closed');
  assert.deepEqual(outboundRuns[1].facts.map((fact) => fact.messageId), [
    'msg-handoff-a-closed',
    'msg-handoff-a-closed',
  ]);
  assert.equal(outboundRuns[2].toolSessionId, 'tool-tui-handoff-b-closed');
  assert.deepEqual(outboundRuns[2].facts.map((fact) => [fact.type, fact.messageId]), [
    ['message.start', 'msg-handoff-b-open'],
    ['permission.ask', 'msg-handoff-b-open'],
    ['message.done', 'msg-handoff-b-open'],
  ]);
  assert.deepEqual(pendingRecords, [{
    kind: 'permission',
    tokenId: 'permission-handoff-b-new-run',
    toolSessionId: 'tool-tui-handoff-b-closed',
    hostSessionId: 'host-tui-handoff-anchor-closed',
  }]);
});

test('TuiOutboundRunRegistry drops queued translations on host close before accept', async () => {
  const accepted = [];
  const emittedRuns = [];
  const firstRunCollected = createDeferred();
  const releaseFirstEmit = createDeferred();
  const registry = new TuiOutboundRunRegistry({
    logger: createLogger(),
    onFinalIdleTimeout: () => undefined,
    onTranslationAccepted: (input) => accepted.push(input),
  });
  const runtimeContext = {
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        emittedRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        firstRunCollected.resolve();
        await releaseFirstEmit.promise;
        return { applied: true };
      },
    },
  };

  registry.push({
    hostSessionId: 'host-tui-registry-close',
    anchorSessionId: 'tool-tui-registry-close-a',
    factSessionContext: {
      anchorSessionId: 'tool-tui-registry-close-a',
      trackingSessionId: 'host-tui-registry-close',
    },
    runtimeContext,
    translation: {
      recognized: true,
      envelopeMessageId: 'msg-registry-close-old',
      facts: [
        { type: 'message.start', messageId: 'msg-registry-close-old' },
        { type: 'message.done', messageId: 'msg-registry-close-old' },
      ],
      terminalCandidateMessageId: 'msg-registry-close-old',
    },
  });
  await withTimeout(firstRunCollected.promise, 'expected first registry outbound run to close');

  registry.push({
    hostSessionId: 'host-tui-registry-close',
    anchorSessionId: 'tool-tui-registry-close-b',
    factSessionContext: {
      anchorSessionId: 'tool-tui-registry-close-b',
      trackingSessionId: 'host-tui-registry-close',
    },
    runtimeContext,
    translation: {
      recognized: true,
      envelopeMessageId: 'permission-registry-close',
      facts: [{
        type: 'permission.ask',
        permissionId: 'permission-registry-close',
        messageId: 'msg-registry-close-b',
        permission: 'shell',
        raw: {},
      }],
    },
  });
  registry.closeByHostSession('host-tui-registry-close');
  releaseFirstEmit.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(emittedRuns.length, 1);
  assert.deepEqual(accepted.map((input) => input.facts.map((fact) => fact.type)), [
    ['message.start', 'message.done'],
  ]);
});

test('provider adapter keeps outbound run open after non-terminal message done', async () => {
  const outboundRuns = [];
  const outboundRunCollected = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-tui-non-terminal', 'host-tui-non-terminal']],
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        outboundRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        outboundRunCollected.resolve();
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-non-terminal',
        id: 'msg-non-terminal-1',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-non-terminal',
        id: 'msg-non-terminal-1',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:01.000Z' },
        finish: 'tool-calls',
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-non-terminal',
        id: 'msg-non-terminal-2',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:02.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-non-terminal',
        id: 'msg-non-terminal-2',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:03.000Z' },
        finish: 'stop',
      },
    },
  });

  await withTimeout(outboundRunCollected.promise, 'expected outbound run to close after terminal candidate');
  assert.equal(outboundRuns.length, 1);
  assert.deepEqual(outboundRuns[0].facts.map((fact) => fact.messageId), [
    'msg-non-terminal-1',
    'msg-non-terminal-1',
    'msg-non-terminal-2',
    'msg-non-terminal-2',
  ]);
});

test('provider adapter keeps outbound run open while assistant message is open across drain timeout', async () => {
  const outboundRuns = [];
  const outboundRunCollected = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-tui-open-message-timeout', 'host-tui-open-message-timeout']],
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        outboundRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        if (facts.some((fact) => fact.type === 'message.done')) {
          outboundRunCollected.resolve();
        }
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-open-message-timeout',
        id: 'msg-open-timeout-1',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z' },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  await adapter.handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: 'host-tui-open-message-timeout',
      messageID: 'msg-open-timeout-1',
      partID: 'part-open-timeout-1',
      delta: 'late',
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-open-message-timeout',
        id: 'msg-open-timeout-1',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:01.000Z' },
        finish: 'stop',
      },
    },
  });

  await withTimeout(outboundRunCollected.promise, 'expected outbound run to close after delayed message done');
  assert.equal(outboundRuns.length, 1);
  assert.deepEqual(outboundRuns[0].facts.map((fact) => fact.type), [
    'message.start',
    'text.delta',
    'message.done',
  ]);
});

test('provider adapter closes outbound run after final idle when assistant message stays open', async () => {
  const logs = [];
  const outboundRuns = [];
  const outboundRunCollected = createDeferred();
  const adapter = createAdapter({
    finalIdleTimeoutMs: 40,
    logger: createCapturingLogger(logs),
    bindings: [['tool-tui-final-idle', 'host-tui-final-idle']],
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        outboundRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        outboundRunCollected.resolve();
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-final-idle',
        id: 'msg-tui-final-idle-1',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z' },
      },
    },
  });

  await withTimeout(outboundRunCollected.promise, 'expected outbound run to close by final idle');
  assert.equal(outboundRuns.length, 1);
  assert.deepEqual(outboundRuns[0].facts.map((fact) => fact.type), ['message.start']);
  assert.equal(logs.some((entry) => entry.level === 'warn'
    && entry.message === 'provider_adapter.protocol_diagnostic'
    && entry.extra?.code === 'outbound_open_message_idle_timeout'
    && entry.extra?.messageIds?.includes('msg-tui-final-idle-1')), true);
});

test('provider adapter keeps outbound run open when terminal candidate arrives while another assistant message is open', async () => {
  const outboundRuns = [];
  const outboundRunCollected = createDeferred();
  const adapter = createAdapter({
    bindings: [['tool-tui-overlap-message', 'host-tui-overlap-message']],
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        outboundRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        if (facts.some((fact) => fact.messageId === 'msg-overlap-2' && fact.type === 'message.done')) {
          outboundRunCollected.resolve();
        }
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-overlap-message',
        id: 'msg-overlap-1',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-overlap-message',
        id: 'msg-overlap-2',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:01.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-overlap-message',
        id: 'msg-overlap-1',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:02.000Z' },
        finish: 'stop',
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  await adapter.handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: 'host-tui-overlap-message',
      messageID: 'msg-overlap-2',
      partID: 'part-overlap-2',
      delta: 'still open',
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-overlap-message',
        id: 'msg-overlap-2',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:03.000Z' },
        finish: 'stop',
      },
    },
  });

  await withTimeout(outboundRunCollected.promise, 'expected outbound run to close after second message done');
  assert.equal(outboundRuns.length, 1);
  assert.deepEqual(outboundRuns[0].facts.map((fact) => [fact.type, fact.messageId]), [
    ['message.start', 'msg-overlap-1'],
    ['message.start', 'msg-overlap-2'],
    ['message.done', 'msg-overlap-1'],
    ['text.delta', 'msg-overlap-2'],
    ['message.done', 'msg-overlap-2'],
  ]);
});

test('provider adapter keeps outbound run anchor locked after attached owner changes', async () => {
  const logs = [];
  const outboundRuns = [];
  const pendingRecords = [];
  const outboundRunCollected = createDeferred();
  const adapter = createAdapter({
    logger: createCapturingLogger(logs),
    bindings: [['tool-tui-anchor-a', 'host-tui-anchor-lock']],
    pendingInteractionRecorder: {
      record: (input) => pendingRecords.push(input),
    },
  });
  await adapter.initialize({
    outbound: {
      async emitOutboundMessage() {
        throw new Error('unexpected outbound message call');
      },
      async emitOutboundRun(input) {
        const facts = await collect(input.facts);
        outboundRuns.push({
          toolSessionId: input.toolSessionId,
          runId: input.runId,
          facts,
        });
        outboundRunCollected.resolve();
        return { applied: true };
      },
    },
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-anchor-lock',
        id: 'msg-anchor-lock-1',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:00.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'permission.asked',
    properties: {
      sessionID: 'host-tui-anchor-lock',
      id: 'permission-anchor-lock-1',
      permission: 'shell',
      tool: {
        messageID: 'msg-anchor-lock-2',
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-anchor-lock',
        id: 'msg-anchor-lock-1',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:01.000Z' },
        finish: 'tool-calls',
      },
    },
  });

  adapter.contextResolver.dependencies.ownershipResolver.attach('host-tui-anchor-lock', 'tool-tui-anchor-b');

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-anchor-lock',
        id: 'msg-anchor-lock-2',
        role: 'assistant',
        time: { created: '2026-05-22T12:00:02.000Z' },
      },
    },
  });
  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'host-tui-anchor-lock',
        id: 'msg-anchor-lock-2',
        role: 'assistant',
        time: { completed: '2026-05-22T12:00:03.000Z' },
        finish: 'stop',
      },
    },
  });

  await withTimeout(outboundRunCollected.promise, 'expected outbound run to close after terminal candidate');
  assert.equal(outboundRuns.length, 1);
  assert.equal(outboundRuns[0].toolSessionId, 'tool-tui-anchor-a');
  assert.equal(outboundRuns[0].facts.some((fact) => fact.type === 'permission.ask'
    && fact.permissionId === 'permission-anchor-lock-1'
    && fact.messageId === 'msg-anchor-lock-2'), true);
  assert.deepEqual(pendingRecords, [{
    kind: 'permission',
    tokenId: 'permission-anchor-lock-1',
    toolSessionId: 'tool-tui-anchor-a',
    hostSessionId: 'host-tui-anchor-lock',
  }]);
  assert.equal(logs.some((entry) => entry.level === 'debug'
    && entry.message === 'provider_adapter.tui_outbound_run_anchor_locked'
    && entry.extra?.hostSessionId === 'host-tui-anchor-lock'
    && entry.extra?.lockedAnchorSessionId === 'tool-tui-anchor-a'
    && entry.extra?.resolvedAnchorSessionId === 'tool-tui-anchor-b'), true);
});
