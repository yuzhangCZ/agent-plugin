import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SdkBridgeRuntime } from '../../src/runtime/SdkBridgeRuntime.ts';
import {
  __resetMessageBridgeStatusForTests,
  getMessageBridgeStatus,
  publishMessageBridgeStatus,
} from '../../src/runtime/MessageBridgeStatusStore.ts';

const require = createRequire(import.meta.url);

function createSdkRuntimeClient(overrides = {}) {
  const base = {
    global: {
      health: async () => ({ healthy: true, version: '9.9.9' }),
    },
    app: {
      log: async () => true,
    },
    session: {
      create: async () => ({
        data: {
          id: 'session-created-default',
          directory: '/session/default-directory',
        },
      }),
      get: async (options) => ({
        data: {
          id: options?.path?.id ?? options?.sessionID ?? 'session-default',
          directory: '/session/default-directory',
        },
      }),
      list: async () => ({ data: [] }),
      prompt: async () => ({ data: { parts: [{ type: 'step-finish' }] } }),
      abort: async () => ({}),
      delete: async () => ({}),
    },
    config: {
      providers: async () => ({ data: { providers: [] } }),
    },
    postSessionIdPermissionsPermissionId: async () => ({ data: true }),
    _client: {
      post: async () => ({ data: undefined }),
    },
  };

  return {
    ...base,
    ...overrides,
    session: {
      ...base.session,
      ...(overrides.session ?? {}),
    },
    config: {
      ...base.config,
      ...(overrides.config ?? {}),
    },
    _client: {
      ...base._client,
      ...(overrides._client ?? {}),
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createResolvedConfig(overrides = {}) {
  const config = {
    config_version: 1,
    enabled: true,
    debug: false,
    gateway: {
      url: 'ws://localhost:8081/ws/agent',
      channel: 'opencode',
    },
    auth: {
      ak: 'test-ak-001',
      sk: 'test-sk-secret-001',
    },
    events: {
      allowlist: ['message.updated'],
    },
  };
  return {
    ...config,
    ...overrides,
    gateway: {
      ...config.gateway,
      ...(overrides.gateway ?? {}),
    },
    auth: {
      ...config.auth,
      ...(overrides.auth ?? {}),
    },
    events: {
      ...config.events,
      ...(overrides.events ?? {}),
    },
  };
}

function createPromptResponse() {
  return {
    data: {
      info: {
        id: 'msg-prompt-1',
      },
      parts: [{ type: 'step-finish' }],
    },
  };
}

function createDirectEntryExtParameters(id = 'user-sdk-reply#bot-sdk-reply') {
  return {
    platformExtParam: {
      businessSessionDomain: 'im',
      businessSessionType: 'direct',
      businessSessionId: id,
    },
  };
}

function installRegisterCaptureWebSocket() {
  const originalWebSocket = globalThis.WebSocket;

  class RegisterCaptureWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor() {
      this.readyState = 0;
      this.sent = [];
      RegisterCaptureWebSocket.instances.push(this);
      setTimeout(() => {
        this.readyState = RegisterCaptureWebSocket.OPEN;
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify({ type: 'register_ok' }) });
      }, 0);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  globalThis.WebSocket = RegisterCaptureWebSocket;
  return {
    RegisterCaptureWebSocket,
    restore() {
      globalThis.WebSocket = originalWebSocket;
    },
  };
}

async function startSdkRuntime(overrides = {}, configOverrides = {}) {
  const runtime = new (class extends SdkBridgeRuntime {
    async resolveConfig() {
      return createResolvedConfig(configOverrides);
    }
  })({
    client: createSdkRuntimeClient(overrides),
    sessionIsolationDataDir: join(tmpdir(), `mb-sdk-runtime-${Date.now()}-${Math.random()}`),
  });

  await runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return runtime;
}

async function flushAppLogs() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function waitFor(condition, label, timeoutMs = 200) {
  const startedAt = Date.now();
  let lastValue;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = condition();
    if (lastValue) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`${label} did not become true; last value: ${JSON.stringify(lastValue)}`);
}

function getProviderAdapter(runtime) {
  return runtime.providerAdapter;
}

function getContextResolver(runtime) {
  return getProviderAdapter(runtime).contextResolver;
}

function getSlashCommandExecutor(runtime) {
  return getProviderAdapter(runtime).chatRunPlanner.dependencies.slashExecutionUseCase.dependencies.slashCommandExecutor;
}

function createEntryContext(businessSessionId = 'user-runtime') {
  return {
    entryKey: {
      businessSessionDomain: 'im',
      businessSessionType: 'direct',
      businessSessionId,
    },
    policy: {
      entryKey: `im:direct:${businessSessionId}`,
      controlled: true,
      allowOpencodeNativeSessions: false,
      allowedSlashCommands: ['new', 'sessions', 'session', 'models', 'model'],
    },
  };
}

test('sdk runtime opts active-run chat requests into provider forwarding', async () => {
  const source = await readFile(new URL('../../src/runtime/SdkBridgeRuntime.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /createBridgeRuntime\(\{[\s\S]*requestRunPolicy:\s*\{\s*activeRunChatPolicy:\s*'forwardToProvider',?\s*\}[\s\S]*\}\)/u,
  );
});

test('sdk runtime forwards same-session active chats so provider adapter supersedes prior host run', async () => {
  const { RegisterCaptureWebSocket, restore } = installRegisterCaptureWebSocket();
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  const promptCalls = [];
  let runtime;

  try {
    runtime = await startSdkRuntime({
      session: {
        create: async () => ({
          data: {
            id: 'ses-sdk-forward',
            directory: '/workspace/sdk-forward',
          },
        }),
        get: async () => ({
          data: {
            id: 'ses-sdk-forward',
            directory: '/workspace/sdk-forward',
          },
        }),
        prompt: async (input) => {
          promptCalls.push(input);
          return promptCalls.length === 1 ? firstPrompt.promise : secondPrompt.promise;
        },
      },
    });
    const ws = RegisterCaptureWebSocket.instances[0];

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'invoke',
        action: 'chat',
        welinkSessionId: 'welink-sdk-forward-1',
        payload: {
          toolSessionId: 'tool-sdk-forward',
          text: 'first',
          extParameters: createDirectEntryExtParameters('user-sdk-forward#bot-sdk-forward'),
        },
      }),
    });
    await waitFor(() => promptCalls.length === 1, 'first same-session prompt start');

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'invoke',
        action: 'chat',
        welinkSessionId: 'welink-sdk-forward-2',
        payload: {
          toolSessionId: 'tool-sdk-forward',
          text: 'second',
          extParameters: createDirectEntryExtParameters('user-sdk-forward#bot-sdk-forward'),
        },
      }),
    });
    const startRunCalls = await waitFor(() => {
      const calls = runtime.sdkRuntime.getDiagnostics().providerCalls.filter(
        (call) => call.command === 'startRequestRun' && call.toolSessionId === 'tool-sdk-forward',
      );
      return calls.length === 2 ? calls : false;
    }, 'second same-session provider call');
    const supersededDone = await waitFor(() => ws.sent.filter((message) =>
      message.type === 'tool_done'
      && message.toolSessionId === 'tool-sdk-forward'
    ).length, 'superseded run terminal');

    assert.equal(startRunCalls.length, 2);
    assert.equal(promptCalls.length, 1);
    assert.equal(supersededDone, 1);
    assert.equal(ws.sent.some((message) =>
      message.type === 'tool_error'
      && message.toolSessionId === 'tool-sdk-forward'
      && message.error === '当前会话正在处理中，请稍后再试'
    ), false);

    await runtime.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-sdk-forward-old',
          sessionID: 'ses-sdk-forward',
          role: 'assistant',
          time: {
            created: Date.now(),
            completed: Date.now(),
          },
          finish: 'stop',
        },
      },
    });
    firstPrompt.resolve(createPromptResponse());
    await waitFor(() => promptCalls.length === 2, 'second same-session prompt start');
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'invoke',
        action: 'abort_session',
        welinkSessionId: 'welink-sdk-forward-3',
        payload: {
          toolSessionId: 'tool-sdk-forward',
        },
      }),
    });
    await waitFor(() => ws.sent.filter((message) =>
      message.type === 'tool_done'
      && message.toolSessionId === 'tool-sdk-forward'
    ).length === 2, 'second same-session run terminal', 1_000);
    secondPrompt.resolve(createPromptResponse());
    await flushAppLogs();

    assert.equal(runtime.sdkRuntime.getDiagnostics().providerCalls.filter(
      (call) => call.command === 'startRequestRun' && call.toolSessionId === 'tool-sdk-forward',
    ).length, 2);
    assert.equal(ws.sent.some((message) =>
      message.type === 'tool_error'
      && message.toolSessionId === 'tool-sdk-forward'
      && message.error === '当前会话正在处理中，请稍后再试'
    ), false);

  } finally {
    runtime?.stop();
    restore();
  }
});

test('sdk runtime telemetry refresh does not republish READY when public status is already ready', () => {
  __resetMessageBridgeStatusForTests();
  publishMessageBridgeStatus({
    connected: true,
    phase: 'ready',
    unavailableReason: null,
    willReconnect: null,
    lastError: null,
    updatedAt: 100,
    lastReadyAt: 100,
  });

  const runtime = new SdkBridgeRuntime({
    client: createSdkRuntimeClient(),
  });
  let readyPublishCount = 0;
  runtime.sdkRuntime = {
    getStatus: () => ({ state: 'ready', failureReason: null }),
  };
  runtime.statusAdapter = {
    publishConnecting() {},
    publishDisabled() {},
    publishConfigInvalid() {},
    publishPluginFailure() {},
    publishRuntimeStatus(status) {
      if (status.state === 'ready') {
        readyPublishCount += 1;
      }
    },
  };

  runtime.syncSdkStatus();

  assert.equal(readyPublishCount, 0);
  assert.deepEqual(getMessageBridgeStatus(), {
    connected: true,
    phase: 'ready',
    unavailableReason: null,
    willReconnect: null,
    lastError: null,
    updatedAt: 100,
    lastReadyAt: 100,
  });
});

test('sdk runtime telemetry publishes failed status even when sdk error is missing', () => {
  const runtime = new SdkBridgeRuntime({
    client: createSdkRuntimeClient(),
  });
  let failedPublishCount = 0;
  runtime.sdkRuntime = {
    getStatus: () => ({ state: 'failed', failureReason: null }),
  };
  runtime.statusAdapter = {
    publishConnecting() {},
    publishDisabled() {},
    publishConfigInvalid() {},
    publishPluginFailure() {},
    publishRuntimeStatus(status) {
      if (status.state === 'failed') {
        failedPublishCount += 1;
      }
    },
  };

  runtime.syncSdkStatus();

  assert.equal(failedPublishCount, 1);
});

test('sdk runtime stop disconnects sdk runtime and resets public status', async () => {
  __resetMessageBridgeStatusForTests();
  publishMessageBridgeStatus({
    connected: true,
    phase: 'ready',
    unavailableReason: null,
    willReconnect: null,
    lastError: null,
    updatedAt: 100,
    lastReadyAt: 100,
  });

  const runtime = new SdkBridgeRuntime({
    client: createSdkRuntimeClient(),
  });
  let stopCalls = 0;
  runtime.started = true;
  runtime.providerAdapter = {};
  runtime.sdkRuntime = {
    stop: async () => {
      stopCalls += 1;
    },
  };

  runtime.stop();
  await flushAppLogs();

  assert.equal(stopCalls, 1);
  assert.equal(runtime.started, false);
  assert.equal(runtime.sdkRuntime, null);
  assert.equal(runtime.providerAdapter, null);
  assert.deepEqual(getMessageBridgeStatus(), {
    connected: false,
    phase: 'unavailable',
    unavailableReason: 'not_ready',
    willReconnect: false,
    lastError: null,
    updatedAt: getMessageBridgeStatus().updatedAt,
    lastReadyAt: null,
  });
});

test('sdk runtime register falls back to source sdk package version when sdkVersion is not injected', async () => {
  const originalSdkPackageVersion = globalThis.__MB_SDK_PACKAGE_VERSION__;
  const originalPluginVersion = globalThis.__MB_PACKAGE_VERSION__;
  const { RegisterCaptureWebSocket, restore } = installRegisterCaptureWebSocket();
  const sdkPackageJson = JSON.parse(await readFile(require.resolve('@wecode/bridge-runtime-sdk/package.json'), 'utf8'));

  delete globalThis.__MB_SDK_PACKAGE_VERSION__;
  delete globalThis.__MB_PACKAGE_VERSION__;

  try {
    const runtime = await startSdkRuntime();

    const ws = RegisterCaptureWebSocket.instances[0];
    assert.equal(ws.sent[0].type, 'register');
    assert.equal(ws.sent[0].toolType, 'opencode');
    assert.equal(ws.sent[0].toolVersion, '9.9.9');
    assert.equal(ws.sent[0].pluginVersion, 'unknown');
    assert.equal(ws.sent[0].sdkVersion, sdkPackageJson.version);

    runtime.stop();
  } finally {
    restore();
    if (typeof originalSdkPackageVersion === 'undefined') {
      delete globalThis.__MB_SDK_PACKAGE_VERSION__;
    } else {
      globalThis.__MB_SDK_PACKAGE_VERSION__ = originalSdkPackageVersion;
    }
    if (typeof originalPluginVersion === 'undefined') {
      delete globalThis.__MB_PACKAGE_VERSION__;
    } else {
      globalThis.__MB_PACKAGE_VERSION__ = originalPluginVersion;
    }
  }
});

test('sdk runtime wires session-isolation control plane into provider adapter', async () => {
  const { restore } = installRegisterCaptureWebSocket();

  try {
    const runtime = await startSdkRuntime();
    const providerAdapter = getProviderAdapter(runtime);
    const contextResolver = getContextResolver(runtime);
    const chatRunPlanner = providerAdapter.chatRunPlanner;

    assert.equal(typeof providerAdapter.createSessionCommandPort.execute, 'function');
    assert.equal(typeof providerAdapter.closeSessionCommandPort.execute, 'function');
    assert.equal(typeof providerAdapter.abortSessionCommandPort.execute, 'function');
    assert.equal(typeof providerAdapter.questionReplyCommandPort.execute, 'function');
    assert.equal(typeof providerAdapter.permissionReplyCommandPort.execute, 'function');
    assert.equal(contextResolver.dependencies.sessionAttachmentPort, undefined);
    assert.equal(typeof chatRunPlanner.dependencies.normalChatSessionResolver.resolve, 'function');
    assert.equal(typeof chatRunPlanner.dependencies.businessEntryContextResolver.resolveRequired, 'function');
    assert.equal(typeof chatRunPlanner.dependencies.businessEntryContextResolver.resolveOptional, 'function');

    runtime.stop();
  } finally {
    restore();
  }
});

test('sdk runtime forwards dialog-only permissions through session creation port', async () => {
  const { restore } = installRegisterCaptureWebSocket();
  const sessionCreateCalls = [];

  try {
    const runtime = await startSdkRuntime({
      session: {
        create: async (params) => {
          sessionCreateCalls.push(params);
          return {
            data: {
              id: 'session-dialog-only',
              title: params?.title,
              directory: params?.directory,
            },
          };
        },
      },
    });

    const result = await getProviderAdapter(runtime).createSession({
      title: 'Dialog Only',
      extParameters: createDirectEntryExtParameters(),
    });

    assert.equal(result.toolSessionId, 'session-dialog-only');
    assert.equal(sessionCreateCalls.length, 1);
    assert.equal(Array.isArray(sessionCreateCalls[0].body?.permission), true);
    assert.deepEqual(sessionCreateCalls[0].body.permission[0], {
      permission: 'bash',
      pattern: '*',
      action: 'deny',
    });

    runtime.stop();
  } finally {
    restore();
  }
});

test('sdk runtime logs session-isolation store file path during startup', async () => {
  const { restore } = installRegisterCaptureWebSocket();
  const logs = [];

  try {
    const runtime = await startSdkRuntime({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const storeLogs = logs.filter((entry) => entry?.message === 'session_isolation.store.configured');
    assert.equal(storeLogs.length, 1);
    assert.equal(storeLogs[0].level, 'info');
    assert.equal(storeLogs[0].extra.pathMode, 'unix_user_local_share');
    assert.equal(storeLogs[0].extra.hasOverrideDataDir, true);
    assert.match(storeLogs[0].extra.filePath, /entry-session-store\.json$/u);

    runtime.stop();
  } finally {
    restore();
  }
});

test('sdk runtime applies config debug to provider adapter child logger', async () => {
  const { restore } = installRegisterCaptureWebSocket();
  const logs = [];

  try {
    const runtime = await startSdkRuntime({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    }, { debug: true });
    getProviderAdapter(runtime).logger.debug('provider_adapter.event.received', {
      eventType: 'message.updated',
      rawSessionId: 'ses-debug-enabled',
    });
    await flushAppLogs();

    const received = logs.find((entry) => entry?.message === 'provider_adapter.event.received');
    assert.equal(received?.level, 'info');
    assert.equal(received?.extra.component, 'provider_adapter');
    assert.equal(received?.extra.runtimeMode, 'sdk');
    assert.equal(received?.extra.eventType, 'message.updated');
    assert.equal(received?.extra.rawSessionId, 'ses-debug-enabled');

    runtime.stop();
  } finally {
    restore();
  }
});

test('sdk runtime keeps provider adapter debug logs unpromoted when final debug config is false', async () => {
  const { restore } = installRegisterCaptureWebSocket();
  const logs = [];

  try {
    const runtime = await startSdkRuntime({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    }, { debug: false });
    getProviderAdapter(runtime).logger.debug('provider_adapter.event.received', {
      eventType: 'message.updated',
      rawSessionId: 'ses-debug-disabled',
    });
    await flushAppLogs();

    const received = logs.find((entry) => entry?.message === 'provider_adapter.event.received');
    assert.equal(received?.level, 'debug');
    assert.equal(received?.extra.component, 'provider_adapter');
    assert.equal(received?.extra.runtimeMode, 'sdk');
    assert.equal(received?.extra.rawSessionId, 'ses-debug-disabled');

    runtime.stop();
  } finally {
    restore();
  }
});

test('sdk runtime keeps non-not-found session.get failures aligned with legacy control-plane semantics', async () => {
  const { restore } = installRegisterCaptureWebSocket();

  try {
    const runtime = await startSdkRuntime({
      session: {
        create: async () => ({
          data: {
            id: 'ses-bound',
            directory: '/workspace/bound',
          },
        }),
        get: async () => ({
          error: {
            code: 'provider_unavailable',
            message: 'provider unavailable',
          },
        }),
      },
    });
    const providerAdapter = getProviderAdapter(runtime);
    const contextResolver = getContextResolver(runtime);
    const { toolSessionId: sessionId } = await providerAdapter.createSession({
      traceId: 'trace-bound',
      title: '绑定会话',
      extParameters: {
        platformExtParam: {
          businessSessionDomain: 'im',
          businessSessionType: 'direct',
          businessSessionId: 'user-bound#bot-bound',
        },
      },
    });
    assert.equal(sessionId, 'ses-bound');

    await assert.rejects(
      async () => contextResolver.resolveForChat(sessionId),
      (error) => {
        assert.equal(error?.errorCode, 'SDK_UNREACHABLE');
        assert.equal(error?.errorMessage, 'Failed to send message');
        assert.equal(error?.errorEvidence?.sourceErrorCode, 'provider_unavailable');
        assert.equal(error?.errorEvidence?.sourceOperation, 'session.get');
        return true;
      },
    );

    assert.deepStrictEqual(contextResolver.dependencies.bindingStore.get(sessionId), {
      anchor: sessionId,
      activeOpencodeSessionId: 'ses-bound',
      status: 'active',
    });
    assert.equal(contextResolver.dependencies.ownershipResolver.resolveAttachedAnchor('ses-bound'), sessionId);

    runtime.stop();
  } finally {
    restore();
  }
});

test('sdk runtime question reply fails closed after slash switches the anchor to another host session', async () => {
  const { restore } = installRegisterCaptureWebSocket();
  const promptDeferred = createDeferred();
  const questionReplyCalls = [];
  let createCount = 0;

  try {
    const runtime = await startSdkRuntime({
      session: {
        create: async () => {
          createCount += 1;
          return {
            data: {
              id: createCount === 1 ? 'ses-sdk-question-1' : 'ses-sdk-question-2',
              directory: createCount === 1 ? '/workspace/question-1' : '/workspace/question-2',
            },
          };
        },
        get: async (options) => ({
          data: {
            id: options?.path?.id ?? options?.sessionID ?? 'session-default',
            directory: options?.path?.id === 'ses-sdk-question-2'
              ? '/workspace/question-2'
              : '/workspace/question-1',
          },
        }),
        prompt: async () => promptDeferred.promise,
      },
      _client: {
        post: async (options) => {
          questionReplyCalls.push(options);
          return { data: true };
        },
      },
    });
    const providerAdapter = getProviderAdapter(runtime);
    const extParameters = createDirectEntryExtParameters();

    const run = await providerAdapter.runMessage({
      traceId: 'trace-sdk-question-run',
      runId: 'run-sdk-question',
      toolSessionId: 'tool-sdk-question',
      text: 'hello',
      extParameters,
    });

    await providerAdapter.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'ses-sdk-question-1',
          id: 'msg-sdk-question-1',
          role: 'assistant',
          time: {
            created: '2026-05-26T10:00:00.000Z',
          },
        },
      },
    });
    await providerAdapter.handleEvent({
      type: 'question.asked',
      properties: {
        sessionID: 'ses-sdk-question-1',
        id: 'question-sdk-1',
        tool: {
          messageID: 'msg-sdk-question-1',
        },
        questions: [{
          question: '确认？',
          options: [{ label: '是' }],
        }],
      },
    });

    const slashRun = await providerAdapter.runMessage({
      traceId: 'trace-sdk-question-slash',
      runId: 'run-sdk-question-slash',
      toolSessionId: 'tool-sdk-question',
      text: '/new',
      extParameters,
    });
    await slashRun.result();

    await assert.rejects(
      () => providerAdapter.replyQuestion({
        traceId: 'trace-sdk-question-reply',
        questionId: 'question-sdk-1',
        answers: [['是']],
      }),
      /question interaction not found/u,
    );
    assert.deepStrictEqual(questionReplyCalls, []);

    promptDeferred.resolve(createPromptResponse());
    await run.result();
    runtime.stop();
  } finally {
    restore();
  }
});

test('sdk runtime model lookup fails closed instead of degrading to model_not_found when providers query fails', async () => {
  const { restore } = installRegisterCaptureWebSocket();

  try {
    const runtime = await startSdkRuntime({
      config: {
        providers: async () => ({
          error: {
            code: 'provider_unavailable',
            message: 'providers unavailable',
          },
        }),
      },
    });
    const slashCommandExecutor = getSlashCommandExecutor(runtime);

    await assert.rejects(
      async () => slashCommandExecutor.execute({
        command: { kind: 'model', providerId: 'openai', modelId: 'gpt-5.4' },
        context: {
          message: {
            traceId: 'trace-model',
            runId: 'run-model',
            toolSessionId: 'anchor-model',
            text: '/model openai/gpt-5.4',
          },
          anchor: 'anchor-model',
          sessionContext: {
            opencodeSessionId: 'ses-model',
            bootstrapSource: 'existing_binding',
          },
          entryContext: createEntryContext('user-model'),
        },
      }),
      (error) => {
        assert.deepStrictEqual(error, {
          code: 'provider_unavailable',
          message: 'providers unavailable',
        });
        return true;
      },
    );

    assert.equal(slashCommandExecutor.dependencies.modelOverrideStore.get('ses-model'), undefined);

    runtime.stop();
  } finally {
    restore();
  }
});
