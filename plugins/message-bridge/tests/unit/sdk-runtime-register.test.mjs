import test from 'node:test';
import assert from 'node:assert/strict';

import { SdkBridgeRuntime } from '../../src/runtime/SdkBridgeRuntime.ts';
import {
  __resetMessageBridgeStatusForTests,
  getMessageBridgeStatus,
  publishMessageBridgeStatus,
} from '../../src/runtime/MessageBridgeStatusStore.ts';

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

function createResolvedConfig() {
  return {
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

async function startSdkRuntime(overrides = {}) {
  const runtime = new (class extends SdkBridgeRuntime {
    async resolveConfig() {
      return createResolvedConfig();
    }
  })({
    client: createSdkRuntimeClient(overrides),
  });

  await runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return runtime;
}

function getProviderAdapter(runtime) {
  return runtime.providerAdapter;
}

function getContextResolver(runtime) {
  return getProviderAdapter(runtime).contextResolver;
}

function getSlashCommandExecutor(runtime) {
  return getProviderAdapter(runtime).chatPreprocessor.dependencies.slashExecutionUseCase.dependencies.slashCommandExecutor;
}

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
    getStatus: () => ({ state: 'ready' }),
  };
  runtime.statusAdapter = {
    publishConnecting() {},
    publishDisabled() {},
    publishConfigInvalid() {},
    publishPluginFailure() {},
    publishGatewayState(state) {
      if (state === 'READY') {
        readyPublishCount += 1;
      }
    },
    publishGatewayError() {},
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

test('sdk runtime register falls back to pluginVersion when sdkVersion is unavailable', async () => {
  const originalSdkPackageVersion = globalThis.__MB_SDK_PACKAGE_VERSION__;
  const originalPluginVersion = globalThis.__MB_PACKAGE_VERSION__;
  const { RegisterCaptureWebSocket, restore } = installRegisterCaptureWebSocket();

  delete globalThis.__MB_SDK_PACKAGE_VERSION__;
  delete globalThis.__MB_PACKAGE_VERSION__;

  try {
    const runtime = await startSdkRuntime();

    const ws = RegisterCaptureWebSocket.instances[0];
    assert.equal(ws.sent[0].type, 'register');
    assert.equal(ws.sent[0].toolType, 'opencode');
    assert.equal(ws.sent[0].toolVersion, '9.9.9');
    assert.equal(ws.sent[0].pluginVersion, 'unknown');
    assert.equal('sdkVersion' in ws.sent[0], false);

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
    const { toolSessionId: sessionId } = await providerAdapter.createSession({ title: '绑定会话' });
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

test('sdk runtime slash session keeps legacy scope filtering and rejects out-of-scope targets', async () => {
  const { restore } = installRegisterCaptureWebSocket();

  try {
    const runtime = await startSdkRuntime({
      session: {
        list: async () => ({
          data: [
            { id: 'ses-match', title: '当前会话', projectID: 'proj-a', workspaceID: 'ws-a', directory: '/workspace/a' },
            { id: 'ses-out', title: '越界会话', projectID: 'proj-b', workspaceID: 'ws-b', directory: '/workspace/b' },
          ],
        }),
      },
    });
    const slashCommandExecutor = getSlashCommandExecutor(runtime);
    const { bindingStore, ownershipResolver } = slashCommandExecutor.dependencies;
    bindingStore.bind('anchor-scope', 'ses-match');
    ownershipResolver.attach('ses-match', 'anchor-scope');

    await assert.rejects(
      async () => slashCommandExecutor.execute(
        { kind: 'session', sessionId: 'ses-out' },
        {
          anchor: 'anchor-scope',
          activeOpencodeSessionId: 'ses-match',
          scope: { projectID: 'proj-a', workspaceID: 'ws-a' },
          bootstrapSource: 'existing_binding',
        },
      ),
      (error) => {
        assert.deepStrictEqual(error, { code: 'session_out_of_scope' });
        return true;
      },
    );

    assert.deepStrictEqual(bindingStore.get('anchor-scope'), {
      anchor: 'anchor-scope',
      activeOpencodeSessionId: 'ses-match',
      status: 'active',
    });

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
      async () => slashCommandExecutor.execute(
        { kind: 'model', providerId: 'openai', modelId: 'gpt-5.4' },
        {
          anchor: 'anchor-model',
          activeOpencodeSessionId: 'ses-model',
          bootstrapSource: 'existing_binding',
        },
      ),
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
