import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MessageBridgePlugin,
  default as DefaultPlugin,
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from '../../src/index.ts';
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

  test('exports private status api helpers', () => {
    assert.strictEqual(typeof getMessageBridgeStatus, 'function');
    assert.strictEqual(typeof subscribeMessageBridgeStatus, 'function');

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.connected, false);
    assert.strictEqual(snapshot.phase, 'unavailable');
    assert.strictEqual(snapshot.unavailableReason, 'not_ready');
    assert.strictEqual(snapshot.willReconnect, false);
  });

  test('binds private status api logs to client.app.log during plugin init', async () => {
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
    const unsubscribe = subscribeMessageBridgeStatus(() => {});
    const snapshot = getMessageBridgeStatus();
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const changedLog = logs.find(
      (entry) => entry?.message === 'status_api.changed' && entry?.extra?.toUnavailableReason === 'disabled',
    );
    const queryLog = logs.find(
      (entry) =>
        entry?.message === 'status_api.query'
        && entry?.extra?.phase === snapshot.phase
        && entry?.extra?.unavailableReason === snapshot.unavailableReason,
    );
    const subscribeLog = logs.find((entry) => entry?.message === 'status_api.subscribe');
    const unsubscribeLog = logs.find((entry) => entry?.message === 'status_api.unsubscribe');

    assert.ok(changedLog);
    assert.strictEqual(changedLog.extra.toPhase, 'unavailable');
    assert.ok(queryLog);
    assert.strictEqual(queryLog.extra.phase, snapshot.phase);
    assert.strictEqual(queryLog.extra.unavailableReason, snapshot.unavailableReason);
    assert.ok(subscribeLog);
    assert.strictEqual(subscribeLog.extra.listenerCount, 1);
    assert.ok(unsubscribeLog);
    assert.strictEqual(unsubscribeLog.extra.listenerCount, 0);
  });

  test('uses one runtimeTraceId across status_api, singleton, and runtime logs in one init', async () => {
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
    getMessageBridgeStatus();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const statusLog = logs.find((entry) => entry?.message === 'status_api.changed');
    const singletonLog = logs.find((entry) => entry?.message === 'runtime.singleton.init_first_attempt_started');
    const runtimeLog = logs.find((entry) => entry?.message === 'runtime.start.requested');

    assert.ok(statusLog);
    assert.ok(singletonLog);
    assert.ok(runtimeLog);

    const statusTraceId = statusLog.extra.runtimeTraceId;
    const singletonTraceId = singletonLog.extra.runtimeTraceId;
    const runtimeTraceId = runtimeLog.extra.runtimeTraceId;

    assert.strictEqual(typeof statusTraceId, 'string');
    assert.strictEqual(typeof singletonTraceId, 'string');
    assert.strictEqual(typeof runtimeTraceId, 'string');
    assert.strictEqual(statusTraceId, singletonTraceId);
    assert.strictEqual(singletonTraceId, runtimeTraceId);
  });

  test('keeps existing private status api logger when later init client has no app.log', async () => {
    const logs = [];
    const loggingClient = createPluginClient({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    });

    await MessageBridgePlugin(mockInput({ client: loggingClient }));
    await MessageBridgePlugin(mockInput({ client: createPluginClient() }));
    const snapshot = getMessageBridgeStatus();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const queryLog = logs.find(
      (entry) =>
        entry?.message === 'status_api.query'
        && entry?.extra?.phase === snapshot.phase
        && entry?.extra?.unavailableReason === snapshot.unavailableReason,
    );

    assert.ok(queryLog);
    assert.strictEqual(queryLog.extra.phase, snapshot.phase);
    assert.strictEqual(queryLog.extra.unavailableReason, snapshot.unavailableReason);
  });

  test('stopRuntime resets status and notifies private status subscribers', async () => {
    await MessageBridgePlugin(mockInput({ client: createPluginClient() }));
    const startedSnapshot = getMessageBridgeStatus();
    assert.strictEqual(startedSnapshot.phase, 'unavailable');
    assert.strictEqual(startedSnapshot.unavailableReason, 'disabled');

    const seen = [];
    const unsubscribe = subscribeMessageBridgeStatus((snapshot) => {
      seen.push(snapshot);
    });

    stopRuntime();
    unsubscribe();

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].phase, 'unavailable');
    assert.strictEqual(seen[0].unavailableReason, 'not_ready');
    assert.strictEqual(seen[0].willReconnect, false);
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

    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function') continue;
      if (name !== 'default' && name !== 'MessageBridgePlugin') continue;
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
    const originalWebSocket = globalThis.WebSocket;
    class CloseBeforeOpenWebSocket {
      constructor() {
        websocketCtorCalls += 1;
        setTimeout(() => {
          this.onclose?.({ code: 1006, reason: 'connect timeout', wasClean: false });
        }, 0);
      }
      send() {}
      close() {}
    }
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
    process.env.BRIDGE_GATEWAY_URL = 'ws://localhost:8081/ws/agent';
    globalThis.WebSocket = CloseBeforeOpenWebSocket;

    try {
      const isolatedInputA = mockInput({
        client,
        directory: fakeWorkspaceA,
        worktree: fakeWorkspaceA,
      });
      const degradedHooksA = await MessageBridgePlugin(isolatedInputA);
      assert.strictEqual(typeof degradedHooksA.event, 'function');
      assert.strictEqual(getRuntime(), null);
      const initFailureLogs = logs.filter((entry) => entry?.message === 'plugin.init.failed_non_fatal');
      assert.strictEqual(initFailureLogs.length, 1);
      assert.strictEqual(typeof initFailureLogs[0].extra.errorDetail, 'string');
      assert.strictEqual(typeof initFailureLogs[0].extra.errorType, 'string');
      assert.strictEqual(typeof initFailureLogs[0].extra.runtimeTraceId, 'string');
      assert.strictEqual(websocketCtorCalls, 1);

      const isolatedInputB = mockInput({
        client,
        directory: fakeWorkspaceB,
        worktree: fakeWorkspaceB,
      });
      const degradedHooksB = await MessageBridgePlugin(isolatedInputB);
      assert.strictEqual(typeof degradedHooksB.event, 'function');
      assert.strictEqual(getRuntime(), null);
      assert.strictEqual(websocketCtorCalls, 1);
      const blockedLogs = logs.filter((entry) => entry?.message === 'runtime.singleton.init_blocked_after_first_attempt');
      assert.strictEqual(blockedLogs.length, 1);
      assert.strictEqual(
        blockedLogs[0].extra.runtimeTraceId,
        initFailureLogs[0].extra.runtimeTraceId,
      );
      const initFailureLogsAfterBlocked = logs.filter((entry) => entry?.message === 'plugin.init.failed_non_fatal');
      assert.strictEqual(initFailureLogsAfterBlocked.length, 1);

      stopRuntime();
      const degradedHooksC = await MessageBridgePlugin(isolatedInputB);
      assert.strictEqual(typeof degradedHooksC.event, 'function');
      assert.strictEqual(websocketCtorCalls, 2);
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

  test('successful first attempt blocks re-init until stopRuntime resets gate', async () => {
    process.env.BRIDGE_ENABLED = 'false';
    const logs = [];
    const client = createPluginClient({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    });

    const hooksA = await MessageBridgePlugin(
      mockInput({
        client,
        directory: '/tmp/workspace-success-a',
        worktree: '/tmp/workspace-success-a',
      }),
    );
    assert.strictEqual(typeof hooksA.event, 'function');
    const runtimeAfterA = getRuntime();
    assert.notStrictEqual(runtimeAfterA, null);

    const hooksBlocked = await MessageBridgePlugin(
      mockInput({
        client,
        directory: '/tmp/workspace-success-b',
        worktree: '/tmp/workspace-success-b',
      }),
    );
    assert.strictEqual(typeof hooksBlocked.event, 'function');
    assert.strictEqual(getRuntime(), runtimeAfterA);

    const blockedLogs = logs.filter((entry) => entry?.message === 'runtime.singleton.init_blocked_after_first_attempt');
    assert.strictEqual(blockedLogs.length, 0);

    const startLogsBeforeStop = logs.filter((entry) => entry?.message === 'runtime.start.requested');
    assert.strictEqual(startLogsBeforeStop.length, 1);
    const reuseLogsBeforeStop = logs.filter((entry) => entry?.message === 'runtime.singleton.reuse_existing');
    assert.strictEqual(reuseLogsBeforeStop.length, 1);
    assert.strictEqual(
      reuseLogsBeforeStop[0].extra.runtimeTraceId,
      startLogsBeforeStop[0].extra.runtimeTraceId,
    );

    stopRuntime();
    assert.strictEqual(getRuntime(), null);

    const hooksB = await MessageBridgePlugin(
      mockInput({
        client,
        directory: '/tmp/workspace-success-b',
        worktree: '/tmp/workspace-success-b',
      }),
    );
    assert.strictEqual(typeof hooksB.event, 'function');
    assert.notStrictEqual(getRuntime(), null);

    const startLogsAfterReset = logs.filter((entry) => entry?.message === 'runtime.start.requested');
    assert.strictEqual(startLogsAfterReset.length, 2);
    assert.notStrictEqual(
      startLogsAfterReset[1].extra.runtimeTraceId,
      startLogsAfterReset[0].extra.runtimeTraceId,
    );
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

    let websocketCtorCalls = 0;
    const logs = [];
    const originalWebSocket = globalThis.WebSocket;
    class SlowOpenWebSocket {
      static OPEN = 1;
      constructor() {
        websocketCtorCalls += 1;
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = SlowOpenWebSocket.OPEN;
          this.onopen?.();
        }, 20);
      }
      send() {}
      close() {
        this.readyState = 3;
        this.onclose?.({ code: 1000, reason: 'manual close', wasClean: true });
      }
    }
    globalThis.WebSocket = SlowOpenWebSocket;

    try {
      const client = createPluginClient({
        app: {
          log: async (options) => {
            logs.push(options?.body);
            return true;
          },
        },
      });
      const inputA = mockInput({
        client,
        directory: '/tmp/workspace-a',
        worktree: '/tmp/workspace-a',
      });
      const inputB = mockInput({
        client,
        directory: '/tmp/workspace-b',
        worktree: '/tmp/workspace-b',
      });
      await Promise.all([getOrCreateRuntime(inputA), getOrCreateRuntime(inputB)]);
      assert.strictEqual(websocketCtorCalls, 1);
      assert.notStrictEqual(getRuntime(), null);
      const initLog = logs.find((entry) => entry?.message === 'runtime.singleton.init_first_attempt_started');
      const waitingLog = logs.find((entry) => entry?.message === 'runtime.singleton.await_initializing');
      assert.ok(initLog);
      assert.ok(waitingLog);
      assert.strictEqual(waitingLog.extra.runtimeTraceId, initLog.extra.runtimeTraceId);
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
