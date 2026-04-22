import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MessageBridgePlugin, default as DefaultPlugin } from '../../src/index.ts';
import { __resetRuntimeForTests, getOrCreateRuntime, getRuntime, stopRuntime } from '../../src/runtime/singleton.ts';

const ORIGINAL_PLUGIN_VERSION = globalThis.__MB_PLUGIN_VERSION__;

function restoreInjectedPluginVersion() {
  if (typeof ORIGINAL_PLUGIN_VERSION === 'undefined') {
    delete globalThis.__MB_PLUGIN_VERSION__;
    return;
  }

  globalThis.__MB_PLUGIN_VERSION__ = ORIGINAL_PLUGIN_VERSION;
}

function createPluginClient(overrides = {}) {
  const base = {
    global: {},
    app: {},
    session: {
      create: async () => ({}),
      get: async (options) => ({
        data: {
          id: options?.path?.id ?? 'session-default',
          directory: '/session/default-directory',
        },
      }),
      abort: async () => ({}),
      delete: async () => ({}),
      prompt: async () => ({}),
    },
    postSessionIdPermissionsPermissionId: async () => ({}),
    _client: {
      get: async (options) => {
        if (options?.url === '/global/health') {
          return { data: { healthy: true, version: '9.9.9' } };
        }
        return { data: [] };
      },
      post: async () => ({ data: undefined }),
    },
  };

  return {
    ...base,
    ...overrides,
    global: { ...base.global, ...(overrides.global ?? {}) },
    app: { ...base.app, ...(overrides.app ?? {}) },
    session: { ...base.session, ...(overrides.session ?? {}) },
    _client: { ...base._client, ...(overrides._client ?? {}) },
  };
}

function mockInput(overrides = {}) {
  return {
    client: {},
    project: {},
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL('http://localhost:4096'),
    $: {},
    ...overrides,
  };
}

describe('plugin contract', () => {
  beforeEach(() => {
    __resetRuntimeForTests();
    process.env.BRIDGE_ENABLED = 'false';
  });

  afterEach(() => {
    restoreInjectedPluginVersion();
  });

  test('exports named and default as same plugin function', () => {
    assert.strictEqual(typeof MessageBridgePlugin, 'function');
    assert.strictEqual(DefaultPlugin, MessageBridgePlugin);
  });

  test('PluginInput -> Hooks', async () => {
    const hooks = await MessageBridgePlugin(mockInput());
    assert.ok(hooks !== null && typeof hooks === 'object');
    assert.strictEqual(typeof hooks.event, 'function');
  });

  test('singleton runtime is idempotent across repeated init', async () => {
    const hooks1 = await MessageBridgePlugin(mockInput());
    const runtime1 = getRuntime();
    const hooks2 = await MessageBridgePlugin(mockInput());
    const runtime2 = getRuntime();

    assert.notStrictEqual(runtime1, undefined);
    assert.strictEqual(runtime2, runtime1);
    assert.strictEqual(typeof hooks1.event, 'function');
    assert.strictEqual(typeof hooks2.event, 'function');
  });

  test('logs injected client shape only once during first singleton init', async () => {
    const logs = [];
    const client = createPluginClient({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    });

    await MessageBridgePlugin(mockInput({ client }));
    await MessageBridgePlugin(mockInput({ client }));
    await new Promise((r) => setTimeout(r, 10));

    const shapeLogs = logs.filter((entry) => entry?.message === 'runtime.singleton.client_shape');
    assert.strictEqual(shapeLogs.length, 1);
    assert.ok(shapeLogs[0].extra.clientTopLevelKeys.includes('app'));
    assert.ok(shapeLogs[0].extra.clientTopLevelKeys.includes('global'));
    assert.ok(shapeLogs[0].extra.clientTopLevelKeys.includes('session'));
    assert.strictEqual(shapeLogs[0].extra.hasGlobalHealth, false);
    assert.strictEqual(shapeLogs[0].extra.hasAppHealth, false);
    assert.strictEqual(shapeLogs[0].extra.hasAppLog, true);
    assert.strictEqual(shapeLogs[0].extra.hasSessionCreate, true);
    assert.strictEqual(shapeLogs[0].extra.hasRawClientGet, true);
    assert.strictEqual(shapeLogs[0].extra.hasRawClientPost, true);
  });

  test('logs plugin version in runtime.start.requested', async () => {
    globalThis.__MB_PLUGIN_VERSION__ = '1.2.0-test';

    const logs = [];
    const client = createPluginClient({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    });

    await MessageBridgePlugin(mockInput({ client }));
    await new Promise((r) => setTimeout(r, 10));

    const startLogs = logs.filter((entry) => entry?.message === 'runtime.start.requested');
    assert.strictEqual(startLogs.length, 1);
    assert.strictEqual(startLogs[0].extra.pluginVersion, '1.2.0-test');
  });

  test('loader semantics: Object.entries + duplicate function references only init once', async () => {
    const mod = await import('../../src/index.ts');
    const seen = new Set();
    const hooks = [];

    for (const [, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function') continue;
      if (seen.has(fn)) continue;
      seen.add(fn);
      hooks.push(await fn(mockInput()));
    }

    assert.strictEqual(hooks.length, 1);
    assert.notStrictEqual(getRuntime(), undefined);
  });

  test('first failed attempt blocks later init across workspaces until stopRuntime resets gate', async () => {
    const originalHome = process.env.HOME;
    const originalGatewayUrl = process.env.BRIDGE_GATEWAY_URL;
    const originalBridgeAuthAk = process.env.BRIDGE_AUTH_AK;
    const originalBridgeAuthSk = process.env.BRIDGE_AUTH_SK;
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-it-home-'));
    const fakeWorkspaceA = await mkdtemp(join(tmpdir(), 'mb-it-workspace-a-'));
    const fakeWorkspaceB = await mkdtemp(join(tmpdir(), 'mb-it-workspace-b-'));
    const logs = [];
    let websocketCtorCalls = 0;
    const client = createPluginClient({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    });
    process.env.HOME = fakeHome;
    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_AUTH_AK = 'ak-test';
    process.env.BRIDGE_AUTH_SK = 'sk-test';
    process.env.BRIDGE_GATEWAY_URL = 'not-a-valid-url';

    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class CountingWebSocket {
      constructor() {
        websocketCtorCalls += 1;
      }
    };

    try {
      const isolatedInputA = mockInput({
        client,
        directory: fakeWorkspaceA,
        worktree: fakeWorkspaceA,
      });
      const isolatedInputB = mockInput({
        client,
        directory: fakeWorkspaceB,
        worktree: fakeWorkspaceB,
      });
      const degradedHooksA = await MessageBridgePlugin(isolatedInputA);
      assert.strictEqual(typeof degradedHooksA.event, 'function');
      assert.strictEqual(getRuntime(), null);
      const initFailureLogs = logs.filter((entry) => entry?.message === 'plugin.init.failed_non_fatal');
      assert.strictEqual(initFailureLogs.length, 1);
      assert.strictEqual(typeof initFailureLogs[0].extra.errorDetail, 'string');
      assert.strictEqual(typeof initFailureLogs[0].extra.errorType, 'string');
      assert.strictEqual(typeof initFailureLogs[0].extra.runtimeTraceId, 'string');

      process.env.BRIDGE_ENABLED = 'false';
      delete process.env.BRIDGE_GATEWAY_URL;
      const degradedHooksB = await MessageBridgePlugin(isolatedInputB);
      assert.strictEqual(typeof degradedHooksB.event, 'function');
      assert.strictEqual(getRuntime(), null);
      assert.strictEqual(websocketCtorCalls, 0);

      const blockedLogs = logs.filter((entry) => entry?.message === 'runtime.singleton.init_blocked_after_first_attempt');
      assert.strictEqual(blockedLogs.length, 1);
      const initFailureLogsAfterBlocked = logs.filter((entry) => entry?.message === 'plugin.init.failed_non_fatal');
      assert.strictEqual(initFailureLogsAfterBlocked.length, 1);

      stopRuntime();
      const hooks = await MessageBridgePlugin(isolatedInputB);
      assert.strictEqual(typeof hooks.event, 'function');
      assert.notStrictEqual(getRuntime(), null);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalBridgeAuthAk === undefined) {
        delete process.env.BRIDGE_AUTH_AK;
      } else {
        process.env.BRIDGE_AUTH_AK = originalBridgeAuthAk;
      }
      if (originalBridgeAuthSk === undefined) {
        delete process.env.BRIDGE_AUTH_SK;
      } else {
        process.env.BRIDGE_AUTH_SK = originalBridgeAuthSk;
      }
      if (originalGatewayUrl === undefined) {
        delete process.env.BRIDGE_GATEWAY_URL;
      } else {
        process.env.BRIDGE_GATEWAY_URL = originalGatewayUrl;
      }
      await rm(fakeHome, { recursive: true, force: true });
      await rm(fakeWorkspaceA, { recursive: true, force: true });
      await rm(fakeWorkspaceB, { recursive: true, force: true });
    }
  });

  test('runtime event failures are non-fatal and logged by plugin boundary', async () => {
    const logs = [];
    const client = createPluginClient({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    });

    const hooks = await MessageBridgePlugin(mockInput({ client }));
    const runtime = getRuntime();
    assert.ok(runtime !== null);

    const originalHandleEvent = runtime.handleEvent.bind(runtime);
    runtime.handleEvent = async () => {
      throw new Error('boom-event');
    };

    try {
      await assert.doesNotReject(hooks.event({ event: { type: 'message.updated' } }));
      await new Promise((r) => setTimeout(r, 10));
      const eventFailureLogs = logs.filter((entry) => entry?.message === 'plugin.event.failed_non_fatal');
      assert.strictEqual(eventFailureLogs.length, 1);
      assert.strictEqual(typeof eventFailureLogs[0].extra.errorDetail, 'string');
      assert.strictEqual(typeof eventFailureLogs[0].extra.errorType, 'string');
      assert.strictEqual(typeof eventFailureLogs[0].extra.runtimeTraceId, 'string');
      assert.strictEqual(eventFailureLogs[0].extra.eventType, 'message.updated');
    } finally {
      runtime.handleEvent = originalHandleEvent;
    }
  });

  test('stop during initialization does not resurrect runtime', async () => {
    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_AUTH_AK = 'ak-test';
    process.env.BRIDGE_AUTH_SK = 'sk-test';
    process.env.BRIDGE_GATEWAY_URL = 'ws://localhost:8081/ws/agent';

    const originalWebSocket = globalThis.WebSocket;
    class SlowOpenWebSocket {
      static OPEN = 1;
      constructor() {
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = SlowOpenWebSocket.OPEN;
          this.onopen?.();
        }, 50);
      }
      send() {}
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = SlowOpenWebSocket;
    try {
      const initializingPromise = getOrCreateRuntime(mockInput({ client: createPluginClient() }));
      stopRuntime();
      await assert.rejects(initializingPromise);
      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(getRuntime(), null);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      delete process.env.BRIDGE_AUTH_AK;
      delete process.env.BRIDGE_AUTH_SK;
      delete process.env.BRIDGE_GATEWAY_URL;
      process.env.BRIDGE_ENABLED = 'false';
      __resetRuntimeForTests();
    }
  });

  test('concurrent first init calls share single initializing promise', async () => {
    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_AUTH_AK = 'ak-test';
    process.env.BRIDGE_AUTH_SK = 'sk-test';
    process.env.BRIDGE_GATEWAY_URL = 'ws://localhost:8081/ws/agent';

    const originalWebSocket = globalThis.WebSocket;
    let websocketCtorCalls = 0;
    class SlowRegisterWebSocket {
      static OPEN = 1;
      constructor() {
        websocketCtorCalls += 1;
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = SlowRegisterWebSocket.OPEN;
          this.onopen?.();
          this.onmessage?.({ data: JSON.stringify({ type: 'register_ok' }) });
        }, 10);
      }
      send() {}
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = SlowRegisterWebSocket;
    try {
      const inputA = mockInput({ client: createPluginClient() });
      const inputB = mockInput({ client: createPluginClient() });
      await Promise.all([getOrCreateRuntime(inputA), getOrCreateRuntime(inputB)]);
      assert.strictEqual(websocketCtorCalls, 1);
      assert.notStrictEqual(getRuntime(), null);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      delete process.env.BRIDGE_AUTH_AK;
      delete process.env.BRIDGE_AUTH_SK;
      delete process.env.BRIDGE_GATEWAY_URL;
      process.env.BRIDGE_ENABLED = 'false';
      __resetRuntimeForTests();
    }
  });
});
