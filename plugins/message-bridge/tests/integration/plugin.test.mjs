import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MessageBridgePlugin,
  default as DefaultPlugin,
  getMessageBridgeStatus,
  startMessageBridgeRuntime,
  stopMessageBridgeRuntime,
  subscribeMessageBridgeStatus,
} from '../../src/index.ts';
import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts';
import { __resetRuntimeForTests, getCurrentRuntimeTraceId, getOrCreateRuntime, getRuntime, stopRuntime } from '../../src/runtime/singleton.ts';
import { __resetMessageBridgeStatusForTests } from '../../src/runtime/MessageBridgeStatusStore.ts';

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

function installReadyWebSocket(delayMs = 0) {
  const originalWebSocket = globalThis.WebSocket;
  let websocketCtorCalls = 0;

  class ReadyWebSocket {
    static OPEN = 1;

    constructor() {
      websocketCtorCalls += 1;
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = ReadyWebSocket.OPEN;
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify({ type: 'register_ok' }) });
      }, delayMs);
    }

    send() {}

    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  globalThis.WebSocket = ReadyWebSocket;
  return {
    restore() {
      globalThis.WebSocket = originalWebSocket;
    },
    getCtorCalls() {
      return websocketCtorCalls;
    },
  };
}

describe('plugin contract', () => {
  beforeEach(() => {
    __resetRuntimeForTests();
    __resetMessageBridgeStatusForTests();
    process.env.BRIDGE_ENABLED = 'false';
  });

  afterEach(() => {
    restoreInjectedPluginVersion();
  });

  test('exports named and default as same plugin function', () => {
    assert.strictEqual(typeof MessageBridgePlugin, 'function');
    assert.strictEqual(DefaultPlugin, MessageBridgePlugin);
    assert.strictEqual(typeof getMessageBridgeStatus, 'function');
    assert.strictEqual(typeof startMessageBridgeRuntime, 'function');
    assert.strictEqual(typeof stopMessageBridgeRuntime, 'function');
    assert.strictEqual(typeof subscribeMessageBridgeStatus, 'function');
  });

  test('explicit start rejects before plugin has been loaded', async () => {
    await assert.rejects(
      startMessageBridgeRuntime(),
      /plugin.*not.*loaded|runtime.*not.*loaded|loaded/i,
    );
  });

  test('status api defaults to not_ready baseline and supports subscriptions', () => {
    const initialSnapshot = getMessageBridgeStatus();
    assert.strictEqual(initialSnapshot.phase, 'unavailable');
    assert.strictEqual(initialSnapshot.unavailableReason, 'not_ready');

    const seen = [];
    const unsubscribe = subscribeMessageBridgeStatus((snapshot) => {
      seen.push(snapshot);
    });
    stopRuntime();
    unsubscribe();

    assert.ok(seen.length <= 1);
    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'not_ready');
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

  test('uses one runtimeTraceId across singleton and runtime logs in one init', async () => {
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

    const singletonLog = logs.find((entry) => entry?.message === 'runtime.singleton.init_first_attempt_started');
    const runtimeLog = logs.find((entry) => entry?.message === 'runtime.start.requested');

    assert.ok(singletonLog);
    assert.ok(runtimeLog);
    assert.strictEqual(typeof singletonLog.extra.runtimeTraceId, 'string');
    assert.strictEqual(singletonLog.extra.runtimeTraceId, runtimeLog.extra.runtimeTraceId);
    assert.strictEqual(getCurrentRuntimeTraceId(), singletonLog.extra.runtimeTraceId);
  });

  test('loader semantics: Object.entries + duplicate function references only init once', async () => {
    const mod = await import('../../src/index.ts');
    const seen = new Set();
    const hooks = [];
    const pluginFns = new Set([mod.default, mod.MessageBridgePlugin]);

    for (const [, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function') continue;
      if (!pluginFns.has(fn)) continue;
      if (seen.has(fn)) continue;
      seen.add(fn);
      hooks.push(await fn(mockInput()));
    }

    assert.strictEqual(hooks.length, 1);
    assert.notStrictEqual(getRuntime(), undefined);
  });

  test('first failed attempt blocks later auto init across workspaces until explicit start bypasses gate', async () => {
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

      process.env.BRIDGE_ENABLED = 'true';
      process.env.BRIDGE_GATEWAY_URL = 'ws://localhost:8081/ws/agent';
      const degradedHooksB = await MessageBridgePlugin(isolatedInputB);
      assert.strictEqual(typeof degradedHooksB.event, 'function');
      assert.strictEqual(getRuntime(), null);
      assert.strictEqual(websocketCtorCalls, 0);

      const blockedLogs = logs.filter((entry) => entry?.message === 'runtime.singleton.init_blocked_after_first_attempt');
      assert.strictEqual(blockedLogs.length, 1);
      assert.strictEqual(blockedLogs[0].extra.runtimeTraceId, initFailureLogs[0].extra.runtimeTraceId);
      const initFailureLogsAfterBlocked = logs.filter((entry) => entry?.message === 'plugin.init.failed_non_fatal');
      assert.strictEqual(initFailureLogsAfterBlocked.length, 1);

      const hooks = await MessageBridgePlugin(isolatedInputB);
      assert.strictEqual(typeof hooks.event, 'function');
      assert.strictEqual(getRuntime(), null);

      const readySocket = installReadyWebSocket();
      await assert.doesNotReject(startMessageBridgeRuntime());
      assert.notStrictEqual(getRuntime(), null);
      readySocket.restore();
      const restartLogs = logs.filter((entry) => entry?.message === 'runtime.start.requested');
      assert.strictEqual(restartLogs.length, 2);
      assert.notStrictEqual(restartLogs[1].extra.runtimeTraceId, initFailureLogs[0].extra.runtimeTraceId);
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

  test('failed auto init still returns dynamic hook that recovers after explicit start', async () => {
    const originalBridgeEnabled = process.env.BRIDGE_ENABLED;
    const originalGatewayUrl = process.env.BRIDGE_GATEWAY_URL;
    const originalBridgeAuthAk = process.env.BRIDGE_AUTH_AK;
    const originalBridgeAuthSk = process.env.BRIDGE_AUTH_SK;
    const fakeWorkspace = await mkdtemp(join(tmpdir(), 'mb-it-dynamic-hook-'));
    const logs = [];
    const client = createPluginClient({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    });

    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_AUTH_AK = 'ak-test';
    process.env.BRIDGE_AUTH_SK = 'sk-test';
    process.env.BRIDGE_GATEWAY_URL = 'not-a-valid-url';

    try {
      const hooks = await MessageBridgePlugin(mockInput({
        client,
        directory: fakeWorkspace,
        worktree: fakeWorkspace,
      }));

      assert.strictEqual(typeof hooks.event, 'function');
      assert.strictEqual(getRuntime(), null);

      await assert.doesNotReject(hooks.event({ event: { type: 'message.updated' } }));

      process.env.BRIDGE_GATEWAY_URL = 'ws://localhost:8081/ws/agent';

      const readySocket = installReadyWebSocket();
      await assert.doesNotReject(startMessageBridgeRuntime());
      assert.notStrictEqual(getRuntime(), null);
      assert.strictEqual(getMessageBridgeStatus().phase, 'ready');

      const runtime = getRuntime();
      const receivedEvents = [];
      const originalHandleEvent = runtime.handleEvent.bind(runtime);
      runtime.handleEvent = async (event) => {
        receivedEvents.push(event);
      };

      try {
        await assert.doesNotReject(hooks.event({ event: { type: 'message.updated', payload: 'after-recover' } }));
        assert.deepStrictEqual(receivedEvents, [{ type: 'message.updated', payload: 'after-recover' }]);
      } finally {
        runtime.handleEvent = originalHandleEvent;
        readySocket.restore();
      }
    } finally {
      if (originalBridgeEnabled === undefined) {
        delete process.env.BRIDGE_ENABLED;
      } else {
        process.env.BRIDGE_ENABLED = originalBridgeEnabled;
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
      await rm(fakeWorkspace, { recursive: true, force: true });
    }
  });

  test('stop locks auto init until explicit start is called again', async () => {
    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_AUTH_AK = 'ak-test';
    process.env.BRIDGE_AUTH_SK = 'sk-test';
    process.env.BRIDGE_GATEWAY_URL = 'ws://localhost:8081/ws/agent';
    const client = createPluginClient();
    const readySocket = installReadyWebSocket();

    try {
      const hooks = await MessageBridgePlugin(mockInput({ client }));
      assert.strictEqual(typeof hooks.event, 'function');
      assert.notStrictEqual(getRuntime(), null);

      stopMessageBridgeRuntime();
      assert.strictEqual(getRuntime(), null);
      assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'not_ready');

      const hooksAfterReload = await MessageBridgePlugin(mockInput({ client }));
      assert.strictEqual(typeof hooksAfterReload.event, 'function');
      assert.strictEqual(getRuntime(), null);

      await assert.doesNotReject(startMessageBridgeRuntime());
      assert.notStrictEqual(getRuntime(), null);
    } finally {
      readySocket.restore();
      delete process.env.BRIDGE_AUTH_AK;
      delete process.env.BRIDGE_AUTH_SK;
      delete process.env.BRIDGE_GATEWAY_URL;
      process.env.BRIDGE_ENABLED = 'false';
    }
  });

  test('explicit start uses latest loaded input and does not auto restart on reload', async () => {
    const originalBridgeEnabled = process.env.BRIDGE_ENABLED;
    const originalBridgeAuthAk = process.env.BRIDGE_AUTH_AK;
    const originalBridgeAuthSk = process.env.BRIDGE_AUTH_SK;
    const originalGatewayUrl = process.env.BRIDGE_GATEWAY_URL;
    const workspaceA = await mkdtemp(join(tmpdir(), 'mb-it-input-a-'));
    const workspaceB = await mkdtemp(join(tmpdir(), 'mb-it-input-b-'));
    const logsA = [];
    const logsB = [];
    const clientA = createPluginClient({
      app: {
        log: async (options) => {
          logsA.push(options?.body);
          return true;
        },
      },
    });
    const clientB = createPluginClient({
      app: {
        log: async (options) => {
          logsB.push(options?.body);
          return true;
        },
      },
    });

    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_AUTH_AK = 'ak-test';
    process.env.BRIDGE_AUTH_SK = 'sk-test';
    process.env.BRIDGE_GATEWAY_URL = 'ws://localhost:8081/ws/agent';
    const readySocket = installReadyWebSocket();

    try {
      await MessageBridgePlugin(mockInput({
        client: clientA,
        directory: workspaceA,
        worktree: workspaceA,
      }));
      assert.notStrictEqual(getRuntime(), null);

      const startLogCountA = logsA.filter((entry) => entry?.message === 'runtime.start.requested').length;

      await MessageBridgePlugin(mockInput({
        client: clientB,
        directory: workspaceB,
        worktree: workspaceB,
      }));

      assert.notStrictEqual(getRuntime(), null);
      assert.strictEqual(logsA.filter((entry) => entry?.message === 'runtime.start.requested').length, startLogCountA);
      assert.strictEqual(logsB.filter((entry) => entry?.message === 'runtime.start.requested').length, 0);

      await assert.doesNotReject(startMessageBridgeRuntime());

      const latestStartLog = logsB.filter((entry) => entry?.message === 'runtime.start.requested').at(-1);
      assert.ok(latestStartLog);
      assert.strictEqual(latestStartLog.extra.workspacePath, workspaceB);
    } finally {
      readySocket.restore();
      if (originalBridgeEnabled === undefined) delete process.env.BRIDGE_ENABLED;
      else process.env.BRIDGE_ENABLED = originalBridgeEnabled;
      if (originalBridgeAuthAk === undefined) delete process.env.BRIDGE_AUTH_AK;
      else process.env.BRIDGE_AUTH_AK = originalBridgeAuthAk;
      if (originalBridgeAuthSk === undefined) delete process.env.BRIDGE_AUTH_SK;
      else process.env.BRIDGE_AUTH_SK = originalBridgeAuthSk;
      if (originalGatewayUrl === undefined) delete process.env.BRIDGE_GATEWAY_URL;
      else process.env.BRIDGE_GATEWAY_URL = originalGatewayUrl;
      await rm(workspaceA, { recursive: true, force: true });
      await rm(workspaceB, { recursive: true, force: true });
    }
  });

  test('explicit start failure keeps reject message equal to lastError', async () => {
    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_AUTH_AK = 'ak-test';
    process.env.BRIDGE_AUTH_SK = 'sk-test';
    process.env.BRIDGE_GATEWAY_URL = 'ws://localhost:8081/ws/agent';
    const readySocket = installReadyWebSocket();

    await MessageBridgePlugin(mockInput({ client: createPluginClient() }));
    assert.notStrictEqual(getRuntime(), null);

    await MessageBridgePlugin(mockInput({
      client: createPluginClient({
        global: {
          health: async () => ({}),
        },
      }),
    }));

    process.env.BRIDGE_ENABLED = 'true';

    let rejection;
    await assert.rejects(
      startMessageBridgeRuntime(),
      (error) => {
        rejection = error;
        return true;
      },
    );

    assert.ok(rejection instanceof Error);
    assert.strictEqual(rejection.message, getMessageBridgeStatus().lastError);
    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'plugin_failure');
    readySocket.restore();
    delete process.env.BRIDGE_AUTH_AK;
    delete process.env.BRIDGE_AUTH_SK;
    delete process.env.BRIDGE_GATEWAY_URL;
    process.env.BRIDGE_ENABLED = 'false';
  });

  test('explicit start disabled failure keeps reject message equal to lastError', async () => {
    let rejection;

    await MessageBridgePlugin(mockInput({ client: createPluginClient() }));
    assert.strictEqual(getRuntime(), null);

    await assert.rejects(
      startMessageBridgeRuntime(),
      (error) => {
        rejection = error;
        return true;
      },
    );

    assert.ok(rejection instanceof Error);
    assert.strictEqual(rejection.message, 'message_bridge_runtime_disabled');
    assert.strictEqual(rejection.message, getMessageBridgeStatus().lastError);
    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'disabled');
  });

  test('explicit start config_invalid failure keeps reject message equal to lastError', async () => {
    process.env.BRIDGE_ENABLED = 'true';
    const originalResolveConfig = BridgeRuntime.prototype.resolveConfig;

    try {
      BridgeRuntime.prototype.resolveConfig = async function mockedResolveConfig() {
        throw new Error('broken config');
      };

      const hooks = await MessageBridgePlugin(mockInput({
        client: createPluginClient(),
      }));
      assert.strictEqual(typeof hooks.event, 'function');
      assert.strictEqual(getRuntime(), null);

      let rejection;
      await assert.rejects(
        startMessageBridgeRuntime(),
        (error) => {
          rejection = error;
          return true;
        },
      );

      assert.ok(rejection instanceof Error);
      assert.strictEqual(rejection.message, 'broken config');
      assert.strictEqual(rejection.message, getMessageBridgeStatus().lastError);
      assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'config_invalid');
    } finally {
      BridgeRuntime.prototype.resolveConfig = originalResolveConfig;
    }
  });

  test('explicit start failure keeps later plugin loads blocked from auto retry', async () => {
    const logs = [];
    const client = createPluginClient({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
      global: {
        health: async () => ({}),
      },
    });

    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_AUTH_AK = 'ak-test';
    process.env.BRIDGE_AUTH_SK = 'sk-test';
    process.env.BRIDGE_GATEWAY_URL = 'ws://localhost:8081/ws/agent';
    const readySocket = installReadyWebSocket();
    await MessageBridgePlugin(mockInput({ client: createPluginClient() }));
    assert.notStrictEqual(getRuntime(), null);

    await MessageBridgePlugin(mockInput({ client }));
    process.env.BRIDGE_ENABLED = 'true';

    await assert.rejects(startMessageBridgeRuntime());
    assert.strictEqual(getRuntime(), null);
    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'plugin_failure');

    const startLogCountBeforeReload = logs.filter((entry) => entry?.message === 'runtime.start.requested').length;
    await MessageBridgePlugin(mockInput({ client }));

    assert.strictEqual(getRuntime(), null);
    assert.strictEqual(
      logs.filter((entry) => entry?.message === 'runtime.start.requested').length,
      startLogCountBeforeReload,
    );
    assert.strictEqual(
      logs.filter((entry) => entry?.message === 'runtime.singleton.init_blocked_after_first_attempt').length,
      1,
    );
    readySocket.restore();
    delete process.env.BRIDGE_AUTH_AK;
    delete process.env.BRIDGE_AUTH_SK;
    delete process.env.BRIDGE_GATEWAY_URL;
    process.env.BRIDGE_ENABLED = 'false';
  });

  test('explicit start while another explicit start is initializing restarts with a new lifecycle attempt', async () => {
    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_AUTH_AK = 'ak-test';
    process.env.BRIDGE_AUTH_SK = 'sk-test';
    process.env.BRIDGE_GATEWAY_URL = 'ws://localhost:8081/ws/agent';

    const logs = [];
    const client = createPluginClient({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    });

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
        }, 30);
      }
      send() {}
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }

    globalThis.WebSocket = SlowRegisterWebSocket;
    try {
      await MessageBridgePlugin(mockInput({ client }));
      stopMessageBridgeRuntime();
      assert.strictEqual(getRuntime(), null);

      const firstStart = startMessageBridgeRuntime();
      const secondStart = startMessageBridgeRuntime();

      const [firstResult, secondResult] = await Promise.allSettled([firstStart, secondStart]);
      assert.strictEqual(firstResult.status, 'rejected');
      assert.match(firstResult.reason?.message ?? String(firstResult.reason), /runtime_start_aborted|runtime_initialization_cancelled/);
      assert.strictEqual(secondResult.status, 'fulfilled');

      assert.notStrictEqual(getRuntime(), null);
      assert.strictEqual(websocketCtorCalls, 2);

      const explicitStartLogs = logs.filter((entry) => entry?.message === 'runtime.singleton.init_explicit_attempt_started');
      assert.strictEqual(explicitStartLogs.length, 2);
      assert.notStrictEqual(explicitStartLogs[0].extra.runtimeTraceId, explicitStartLogs[1].extra.runtimeTraceId);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      delete process.env.BRIDGE_AUTH_AK;
      delete process.env.BRIDGE_AUTH_SK;
      delete process.env.BRIDGE_GATEWAY_URL;
      process.env.BRIDGE_ENABLED = 'false';
    }
  });

  test('runtime event failures are non-fatal and logged by plugin boundary', async () => {
    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_AUTH_AK = 'ak-test';
    process.env.BRIDGE_AUTH_SK = 'sk-test';
    process.env.BRIDGE_GATEWAY_URL = 'ws://localhost:8081/ws/agent';
    const logs = [];
    const client = createPluginClient({
      app: {
        log: async (options) => {
          logs.push(options?.body);
          return true;
        },
      },
    });

    const readySocket = installReadyWebSocket();
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
      readySocket.restore();
      delete process.env.BRIDGE_AUTH_AK;
      delete process.env.BRIDGE_AUTH_SK;
      delete process.env.BRIDGE_GATEWAY_URL;
      process.env.BRIDGE_ENABLED = 'false';
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
      const logs = [];
      const client = createPluginClient({
        app: {
          log: async (options) => {
            logs.push(options?.body);
            return true;
          },
        },
      });
      const inputA = mockInput({ client });
      const inputB = mockInput({ client });
      await Promise.all([getOrCreateRuntime(inputA), getOrCreateRuntime(inputB)]);
      assert.strictEqual(websocketCtorCalls, 1);
      assert.notStrictEqual(getRuntime(), null);
      await new Promise((r) => setTimeout(r, 10));

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
