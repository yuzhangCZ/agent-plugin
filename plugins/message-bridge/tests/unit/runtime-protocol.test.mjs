import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os, { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInvalidInvokeToolErrorContract,
  createInvalidInvokeInboundFrame,
} from '@agent-plugin/test-support/assertions';
import { validateGatewayUplinkBusinessMessage } from '@agent-plugin/gateway-schema';

import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts';
import {
  __resetMessageBridgeStatusForTests,
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from '../../src/runtime/MessageBridgeStatusStore.ts';
import { EventFilter } from '../../src/event/EventFilter.ts';
import { setRuntimeGatewayState } from '../helpers/mock-gateway.mjs';

function createRuntimeClient(overrides = {}) {
  const base = {
    global: {},
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

  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(overrides, key);

  return {
    ...base,
    ...overrides,
    app: hasOwn('app') ? (overrides.app ? { ...overrides.app } : overrides.app) : undefined,
    session: {
      ...base.session,
      ...(overrides.session ?? {}),
    },
    _client: hasOwn('_client')
      ? (overrides._client ? { ...base._client, ...overrides._client } : overrides._client)
      : base._client,
    global: hasOwn('global')
      ? (overrides.global ? { ...base.global, ...overrides.global } : overrides.global)
      : base.global,
  };
}

function createResolvedConfig(overrides = {}) {
  return {
    config_version: 1,
    enabled: true,
    debug: false,
    gateway: {
      url: 'ws://localhost:8081/ws/agent',
      channel: 'openx',
      heartbeatIntervalMs: 30000,
      reconnect: {
        baseMs: 1000,
        maxMs: 30000,
        exponential: true,
        jitter: 'full',
        maxElapsedMs: 600000,
      },
    },
    sdk: {
      timeoutMs: 10000,
    },
    auth: {
      ak: 'test-ak-001',
      sk: 'test-sk-secret-001',
    },
    events: {
      allowlist: ['message.updated'],
    },
    ...overrides,
  };
}

function createRuntimeWithResolvedConfig(config, options = {}) {
  return new (class extends BridgeRuntime {
    async resolveConfig() {
      return config;
    }
  })({
    client: createRuntimeClient(),
    ...options,
  });
}

async function writeEnabledConfig(workspace) {
  await mkdir(join(workspace, '.opencode'), { recursive: true });
  await writeFile(
    join(workspace, '.opencode', 'message-bridge.json'),
    JSON.stringify({
      config_version: 1,
      enabled: true,
      gateway: {
        url: 'ws://localhost:8081/ws/agent',
        channel: 'openx',
        heartbeatIntervalMs: 30000,
        reconnect: {
          baseMs: 1000,
          maxMs: 30000,
          exponential: true,
          jitter: 'full',
          maxElapsedMs: 600000,
        },
      },
      sdk: {
        timeoutMs: 10000,
      },
      auth: {
        ak: 'test-ak-001',
        sk: 'test-sk-secret-001',
      },
      events: {
        allowlist: ['message.updated'],
      },
    }),
    'utf8',
  );
}

function createRegisterCaptureWebSocket() {
  return class RegisterCaptureWebSocket {
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
  };
}

function createGatewayConnectionMock(state = 'DISCONNECTED') {
  let currentState = state;
  return {
    send: () => undefined,
    disconnect: () => undefined,
    getState: () => currentState,
    getStatus: () => ({
      isReady: () => currentState === 'READY',
    }),
    setState: (next) => {
      currentState = next;
    },
    on: () => undefined,
  };
}

function createEventedGatewayConnectionMock(state = 'READY') {
  let currentState = state;
  const listeners = new Map();
  const sent = [];
  return {
    sent,
    send: (message) => sent.push(message),
    disconnect: () => undefined,
    connect: async () => undefined,
    getState: () => currentState,
    getStatus: () => ({
      isReady: () => currentState === 'READY',
    }),
    setState: (next) => {
      currentState = next;
    },
    on: (event, listener) => {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    },
    off: (event, listener) => {
      const current = listeners.get(event) ?? [];
      listeners.set(event, current.filter((candidate) => candidate !== listener));
    },
    emit: (event, payload) => {
      if (event === 'stateChange') {
        currentState = payload;
      }
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
  };
}

function createControlledGatewayConnectionMock(state = 'DISCONNECTED') {
  const connection = createEventedGatewayConnectionMock(state);
  let resolveConnect;
  let rejectConnect;
  const connectPromise = new Promise((resolve, reject) => {
    resolveConnect = resolve;
    rejectConnect = reject;
  });
  connection.connect = async () => connectPromise;
  connection.resolveConnect = () => {
    resolveConnect();
  };
  connection.rejectConnect = (error) => {
    rejectConnect(error);
  };
  return connection;
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

describe('runtime protocol strictness', () => {
  test('status api starts from not_ready baseline', () => {
    __resetMessageBridgeStatusForTests();

    assert.deepStrictEqual(getMessageBridgeStatus(), {
      connected: false,
      phase: 'unavailable',
      unavailableReason: 'not_ready',
      willReconnect: false,
      lastError: null,
      updatedAt: getMessageBridgeStatus().updatedAt,
      lastReadyAt: null,
    });
  });

  test('start publishes disabled snapshot when config disables runtime', async () => {
    __resetMessageBridgeStatusForTests();
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig({ enabled: false }));

    let rejection;
    await assert.rejects(runtime.start(), (error) => {
      rejection = error;
      return true;
    });

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.phase, 'unavailable');
    assert.strictEqual(snapshot.unavailableReason, 'disabled');
    assert.strictEqual(snapshot.lastError, 'message_bridge_runtime_disabled');
    assert.strictEqual(rejection.message, snapshot.lastError);
  });

  test('start publishes config_invalid snapshot when config loading fails', async () => {
    __resetMessageBridgeStatusForTests();
    const runtime = new (class extends BridgeRuntime {
      async resolveConfig() {
        throw new Error('broken config');
      }
    })({
      client: createRuntimeClient(),
    });

    await assert.rejects(runtime.start(), /broken config/);

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.phase, 'unavailable');
    assert.strictEqual(snapshot.unavailableReason, 'config_invalid');
    assert.strictEqual(snapshot.lastError, 'broken config');
  });

  test('start publishes plugin_failure snapshot when startup prerequisites fail', async () => {
    __resetMessageBridgeStatusForTests();
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig(), {
      client: createRuntimeClient({
        _client: {
          get: async () => ({ data: { healthy: true } }),
        },
      }),
    });

    await assert.rejects(runtime.start());

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.phase, 'unavailable');
    assert.strictEqual(snapshot.unavailableReason, 'plugin_failure');
    assert.strictEqual(typeof snapshot.lastError, 'string');
  });

  test('start and stop publish connecting ready and reset snapshots', async () => {
    __resetMessageBridgeStatusForTests();
    const connection = createEventedGatewayConnectionMock('DISCONNECTED');
    connection.connect = async () => {
      connection.emit('stateChange', 'CONNECTING');
      connection.emit('stateChange', 'READY');
    };
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig());
    runtime.createGatewayConnection = () => connection;
    const seen = [];
    const unsubscribe = subscribeMessageBridgeStatus((snapshot) => {
      seen.push(snapshot.phase);
    });

    await runtime.start();
    assert.strictEqual(getMessageBridgeStatus().phase, 'ready');

    runtime.stop();
    unsubscribe();

    assert.ok(seen.includes('connecting'));
    assert.ok(seen.includes('ready'));
    assert.strictEqual(getMessageBridgeStatus().unavailableReason, 'not_ready');
  });

  test('gateway error fact publishes server failure and keeps precedence over later network failure', async () => {
    __resetMessageBridgeStatusForTests();
    const connection = createEventedGatewayConnectionMock('DISCONNECTED');
    connection.connect = async () => {
      connection.emit('stateChange', 'READY');
      connection.emit('error', {
        code: 'GATEWAY_HANDSHAKE_REJECTED',
        disposition: 'startup_failure',
        stage: 'handshake',
        retryable: false,
        message: 'device conflict',
      });
      connection.emit('error', {
        code: 'GATEWAY_TRANSPORT_ERROR',
        disposition: 'runtime_failure',
        stage: 'ready',
        retryable: true,
        message: 'network jitter',
      });
    };
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig());
    runtime.createGatewayConnection = () => connection;

    await runtime.start();

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.unavailableReason, 'server_failure');
    assert.strictEqual(snapshot.lastError, 'device conflict');
  });

  test('stop resets to not_ready and ignores late READY and error from stale connection', async () => {
    __resetMessageBridgeStatusForTests();
    const connection = createEventedGatewayConnectionMock('DISCONNECTED');
    connection.connect = async () => {
      connection.emit('stateChange', 'READY');
    };
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig());
    runtime.createGatewayConnection = () => connection;

    await runtime.start();
    runtime.stop();
    connection.emit('stateChange', 'READY');
    connection.emit('error', {
      code: 'GATEWAY_TRANSPORT_ERROR',
      disposition: 'runtime_failure',
      stage: 'ready',
      retryable: true,
      message: 'late socket down',
    });

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.phase, 'unavailable');
    assert.strictEqual(snapshot.unavailableReason, 'not_ready');
    assert.strictEqual(snapshot.lastError, null);
  });

  test('replaced connection ignores late events from previous start attempt', async () => {
    __resetMessageBridgeStatusForTests();
    const firstConnection = createControlledGatewayConnectionMock('DISCONNECTED');
    const secondConnection = createEventedGatewayConnectionMock('DISCONNECTED');
    secondConnection.connect = async () => {
      secondConnection.emit('stateChange', 'READY');
    };
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig());
    let createCalls = 0;
    runtime.createGatewayConnection = () => {
      createCalls += 1;
      return createCalls === 1 ? firstConnection : secondConnection;
    };

    const firstStart = runtime.start();
    await Promise.resolve();
    await runtime.start();

    firstConnection.emit('stateChange', 'READY');
    firstConnection.emit('error', {
      code: 'GATEWAY_TRANSPORT_ERROR',
      disposition: 'startup_failure',
      stage: 'pre_open',
      retryable: true,
      message: 'stale connect failed',
    });

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.phase, 'ready');
    assert.strictEqual(snapshot.unavailableReason, null);

    firstConnection.resolveConnect();
    await assert.rejects(firstStart, /runtime_start_aborted/);
    assert.strictEqual(runtime.getStarted(), true);
  });

  test('aborted_before_connect disconnects created connection before throwing', async () => {
    __resetMessageBridgeStatusForTests();
    const abortController = new AbortController();
    const connection = {
      disconnectCalls: 0,
      connectCalls: 0,
      disconnect() {
        this.disconnectCalls += 1;
      },
      async connect() {
        this.connectCalls += 1;
      },
      getState: () => 'DISCONNECTED',
      getStatus: () => ({ isReady: () => false }),
      on: () => undefined,
    };
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig());
    runtime.createGatewayConnection = () => {
      abortController.abort();
      return connection;
    };

    await assert.rejects(runtime.start({ abortSignal: abortController.signal }), /runtime_start_aborted/);

    assert.strictEqual(connection.disconnectCalls, 1);
    assert.strictEqual(connection.connectCalls, 0);
  });

  test('stop prevents stale downstream handler from sending status_response and logs skip', async () => {
    const logEntries = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            logEntries.push(options.body);
          },
        },
      }),
    });
    const connection = createEventedGatewayConnectionMock('READY');
    const routeDeferred = createDeferred();
    runtime.gatewayConnection = connection;
    runtime.actionRouter = {
      route: async () => routeDeferred.promise,
    };

    const handling = runtime.handleDownstreamMessage({
      type: 'status_query',
      messageId: 'msg-status-stale',
    });
    await Promise.resolve();
    runtime.stop();
    routeDeferred.resolve({ success: true, data: { opencodeOnline: true } });
    await handling;
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(connection.sent.length, 0);
    assert.ok(logEntries.some((entry) => entry.message === 'runtime.send.skipped_stale_connection'));
  });

  test('stop prevents stale downstream handler from sending tool_error', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });
    const connection = createEventedGatewayConnectionMock('READY');
    const routeDeferred = createDeferred();
    runtime.gatewayConnection = connection;
    runtime.actionRouter = {
      route: async () => routeDeferred.promise,
    };

    const handling = runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-tool-error-stale',
      action: 'chat',
      payload: { toolSessionId: 'tool-error-stale', text: 'hello' },
    });
    await Promise.resolve();
    runtime.stop();
    routeDeferred.resolve({
      success: false,
      errorCode: 'SDK_UNREACHABLE',
      errorMessage: 'late failure',
    });
    await handling;

    assert.strictEqual(connection.sent.length, 0);
  });

  test('replaced connection prevents stale downstream handler from sending session_created', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });
    const firstConnection = createEventedGatewayConnectionMock('READY');
    const secondConnection = createEventedGatewayConnectionMock('READY');
    const routeDeferred = createDeferred();
    runtime.gatewayConnection = firstConnection;
    runtime.actionRouter = {
      route: async () => routeDeferred.promise,
    };

    const handling = runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-create-stale',
      action: 'create_session',
      payload: { title: 'late create' },
    });
    await Promise.resolve();
    runtime.gatewayConnection = secondConnection;
    routeDeferred.resolve({
      success: true,
      data: { sessionId: 'tool-created', directory: '/tmp/tool-created' },
    });
    await handling;

    assert.strictEqual(firstConnection.sent.length, 0);
    assert.strictEqual(secondConnection.sent.length, 0);
  });

  test('replaced connection prevents stale downstream handler from sending tool_done', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });
    const firstConnection = createEventedGatewayConnectionMock('READY');
    const secondConnection = createEventedGatewayConnectionMock('READY');
    const routeDeferred = createDeferred();
    runtime.gatewayConnection = firstConnection;
    runtime.actionRouter = {
      route: async () => routeDeferred.promise,
    };

    const handling = runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-tool-done-stale',
      action: 'chat',
      payload: { toolSessionId: 'tool-done-stale', text: 'hello' },
    });
    await Promise.resolve();
    runtime.gatewayConnection = secondConnection;
    routeDeferred.resolve({
      success: true,
      data: { ok: true },
    });
    await handling;

    assert.strictEqual(firstConnection.sent.length, 0);
    assert.strictEqual(secondConnection.sent.length, 0);
  });

  test('connect rejection publishes startup transport failure from connect reject path', async () => {
    __resetMessageBridgeStatusForTests();
    const emittedError = {
      code: 'GATEWAY_TRANSPORT_ERROR',
      disposition: 'startup_failure',
      stage: 'pre_open',
      retryable: true,
      message: 'socket down',
    };
    const connection = createEventedGatewayConnectionMock('DISCONNECTED');
    connection.connect = async () => {
      connection.emit('stateChange', 'CONNECTING');
      throw Object.assign(new Error('socket down'), emittedError);
    };
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig());
    runtime.createGatewayConnection = () => connection;

    let rejection;
    await assert.rejects(runtime.start(), (error) => {
      rejection = error;
      return true;
    });

    const snapshot = getMessageBridgeStatus();
    assert.strictEqual(snapshot.unavailableReason, 'network_failure');
    assert.strictEqual(snapshot.lastError, 'socket down');
    assert.strictEqual(rejection.message, snapshot.lastError);
  });

  test('start wires invalid invoke inbound frames to tool_error best-effort reply', async () => {
    const logEntries = [];
    const connection = createEventedGatewayConnectionMock('READY');
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig(), {
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            if (options?.body) {
              logEntries.push(options.body);
            }
          },
        },
      }),
    });
    runtime.createGatewayConnection = () => connection;

    await runtime.start();
    connection.emit('inbound', createInvalidInvokeInboundFrame());
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(connection.sent.length, 1);
    assertInvalidInvokeToolErrorContract(connection.sent[0], {
      code: 'missing_required_field',
      welinkSessionId: 'wl-invalid-1',
      toolSessionId: 'tool-invalid-1',
    });
    assert.strictEqual(
      logEntries.some((entry) => entry.message === 'runtime.invalid_invoke.replying_tool_error'),
      true,
    );

    runtime.stop();
  });

  test('start logs unroutable invalid invoke inbound frames without sending tool_error', async () => {
    const logEntries = [];
    const connection = createEventedGatewayConnectionMock('READY');
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig(), {
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            if (options?.body) {
              logEntries.push(options.body);
            }
          },
        },
      }),
    });
    runtime.createGatewayConnection = () => connection;

    await runtime.start();
    connection.emit(
      'inbound',
      createInvalidInvokeInboundFrame({
        welinkSessionId: undefined,
        toolSessionId: undefined,
        violation: {
          violation: {
            stage: 'payload',
            code: 'missing_required_field',
            field: 'payload.text',
            message: 'payload.text is required',
            messageType: 'invoke',
            action: 'chat',
          },
        },
        rawPreview: {
          type: 'invoke',
          action: 'chat',
          payload: {},
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(connection.sent, []);
    assert.strictEqual(
      logEntries.some((entry) => entry.message === 'runtime.invalid_invoke.unreplyable'),
      true,
    );

    runtime.stop();
  });

  test('start skips tool_error reply for invalid invoke inbound frames before READY', async () => {
    const logEntries = [];
    const connection = createEventedGatewayConnectionMock('CONNECTED');
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig(), {
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            if (options?.body) {
              logEntries.push(options.body);
            }
          },
        },
      }),
    });
    runtime.createGatewayConnection = () => connection;

    await runtime.start();
    connection.emit('inbound', createInvalidInvokeInboundFrame());
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(connection.sent, []);
    assert.strictEqual(
      logEntries.some((entry) => entry.message === 'runtime.invalid_invoke.skipped_not_ready'),
      true,
    );

    runtime.stop();
  });

  test('start ignores error events for invalid-invoke tool_error bridging', async () => {
    const logEntries = [];
    const connection = createEventedGatewayConnectionMock('READY');
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig(), {
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            if (options?.body) {
              logEntries.push(options.body);
            }
          },
        },
      }),
    });
    runtime.createGatewayConnection = () => connection;

    await runtime.start();
    connection.emit('error', new Error('gateway protocol error'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(connection.sent, []);
    assert.strictEqual(
      logEntries.some((entry) => String(entry.message).startsWith('runtime.invalid_invoke.')),
      false,
    );

    runtime.stop();
  });

  test('start replies tool_error when only welinkSessionId is routable', async () => {
    const connection = createEventedGatewayConnectionMock('READY');
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig(), {
      client: createRuntimeClient(),
    });
    runtime.createGatewayConnection = () => connection;

    await runtime.start();
    connection.emit(
      'inbound',
      createInvalidInvokeInboundFrame({
        toolSessionId: undefined,
        violation: {
          violation: {
            stage: 'payload',
            code: 'missing_required_field',
            field: 'payload.text',
            message: 'payload.text is required',
            messageType: 'invoke',
            action: 'chat',
            welinkSessionId: 'wl-invalid-1',
          },
        },
        rawPreview: {
          type: 'invoke',
          messageId: 'gw-invalid-1',
          action: 'chat',
          welinkSessionId: 'wl-invalid-1',
          payload: {},
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(connection.sent.length, 1);
    assertInvalidInvokeToolErrorContract(connection.sent[0], {
      code: 'missing_required_field',
      welinkSessionId: 'wl-invalid-1',
      toolSessionId: undefined,
    });

    runtime.stop();
  });

  test('start replies tool_error when only toolSessionId is routable', async () => {
    const connection = createEventedGatewayConnectionMock('READY');
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig(), {
      client: createRuntimeClient(),
    });
    runtime.createGatewayConnection = () => connection;

    await runtime.start();
    connection.emit(
      'inbound',
      createInvalidInvokeInboundFrame({
        welinkSessionId: undefined,
        violation: {
          violation: {
            stage: 'payload',
            code: 'missing_required_field',
            field: 'payload.text',
            message: 'payload.text is required',
            messageType: 'invoke',
            action: 'chat',
            toolSessionId: 'tool-invalid-1',
          },
        },
        rawPreview: {
          type: 'invoke',
          messageId: 'gw-invalid-1',
          action: 'chat',
          payload: {
            toolSessionId: 'tool-invalid-1',
          },
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(connection.sent.length, 1);
    assertInvalidInvokeToolErrorContract(connection.sent[0], {
      code: 'missing_required_field',
      welinkSessionId: undefined,
      toolSessionId: 'tool-invalid-1',
    });

    runtime.stop();
  });

  test('handleDownstreamMessage does not emit downstream normalization failure for typed status_query facade messages', async () => {
    const logEntries = [];
    const sent = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            if (options?.body) {
              logEntries.push(options.body);
            }
          },
        },
      }),
    });
    runtime.gatewayConnection = {
      send: (msg) => sent.push(msg),
      getState: () => 'ready',
    };

    await runtime.handleDownstreamMessage({
      type: 'status_query',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'status_response');
    assert.deepStrictEqual(
      logEntries
        .filter((entry) => entry.message === 'downstream.normalization_failed')
        .map((entry) => entry.message),
      [],
    );
  });

  test('handleDownstreamMessage fails closed when adapter rejects spoofed typed facade action', async () => {
    const logEntries = [];
    const sent = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            if (options?.body) {
              logEntries.push(options.body);
            }
          },
        },
      }),
    });
    runtime.gatewayConnection = {
      send: (msg) => sent.push(msg),
    };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-invalid-2',
      action: 'delete_session',
      payload: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'tool_error');
    assert.strictEqual(sent[0].welinkSessionId, 'wl-invalid-2');
    assert.strictEqual(
      logEntries.some((entry) => entry.message === 'downstream.normalization_failed'),
      false,
    );
  });

  test('gates invoke handling through gateway status view instead of local state manager', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });

    const sent = [];
    let routeCalls = 0;
    const connection = createGatewayConnectionMock('CONNECTING');
    connection.send = (msg) => sent.push(msg);
    runtime.gatewayConnection = connection;
    runtime.actionRouter = {
      route: async () => {
        routeCalls += 1;
        return { success: true, data: { sessionId: 'unexpected' } };
      },
    };

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'not-ready-chat',
      action: 'chat',
      payload: { toolSessionId: 'tool-not-ready', text: 'hello' },
    });

    assert.strictEqual(routeCalls, 0);
    assert.deepStrictEqual(sent, []);
  });

  test('ignores invoke messages until runtime state is READY', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });

    const sent = [];
    let routeCalls = 0;
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    runtime.actionRouter = {
      route: async () => {
        routeCalls += 1;
        return { success: true, data: { sessionId: 'unexpected' } };
      },
    };
    setRuntimeGatewayState(runtime, 'CONNECTING');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'not-ready-chat',
      action: 'chat',
      payload: { toolSessionId: 'tool-not-ready', text: 'hello' },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'not-ready-create',
      action: 'create_session',
      payload: { title: 'should be ignored' },
    });

    assert.strictEqual(routeCalls, 0);
    assert.deepStrictEqual(sent, []);
  });

  test('chat session-not-found failure adds tool_error reason for auto-rebuild', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');
    runtime.actionRouter = {
      route: async () => ({
        success: false,
        errorCode: 'SDK_UNREACHABLE',
        errorMessage: 'Failed to send message',
        errorEvidence: {
          sourceErrorCode: 'session_not_found',
          sourceOperation: 'session.get',
        },
      }),
    };

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 's-rebuild',
      action: 'chat',
      payload: { toolSessionId: 'tool-rebuild', text: 'hello' },
    });

    assert.strictEqual((sent).length, 1);
    assert.deepStrictEqual(sent[0], {
      type: 'tool_error',
      welinkSessionId: 's-rebuild',
      toolSessionId: 'tool-rebuild',
      error: 'Failed to send message',
      reason: 'session_not_found',
    });
  });

  test('close_session not-found text does not collapse to session_not_found', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');
    runtime.actionRouter = {
      route: async () => ({
        success: false,
        errorCode: 'INVALID_PAYLOAD',
        errorMessage: 'session not found',
      }),
    };

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 's-close',
      action: 'close_session',
      payload: { toolSessionId: 'tool-close' },
    });

    assert.strictEqual((sent).length, 1);
    assert.strictEqual(sent[0].type, 'tool_error');
    assert.strictEqual(sent[0].reason, undefined);
  });

  test('close_session session_not_found evidence does not collapse to session_not_found', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');
    runtime.actionRouter = {
      route: async () => ({
        success: false,
        errorCode: 'SDK_UNREACHABLE',
        errorMessage: 'Failed to close session',
        errorEvidence: {
          sourceErrorCode: 'session_not_found',
          sourceOperation: 'session.get',
        },
      }),
    };

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 's-close-evidence',
      action: 'close_session',
      payload: { toolSessionId: 'tool-close-evidence' },
    });

    assert.strictEqual((sent).length, 1);
    assert.strictEqual(sent[0].type, 'tool_error');
    assert.strictEqual(sent[0].reason, undefined);
  });

  test('create_session session_not_found evidence does not collapse to session_not_found', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');
    runtime.actionRouter = {
      route: async () => ({
        success: false,
        errorCode: 'SDK_UNREACHABLE',
        errorMessage: 'Failed to create session',
        errorEvidence: {
          sourceErrorCode: 'session_not_found',
          sourceOperation: 'session.get',
        },
      }),
    };

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 's-create-evidence',
      action: 'create_session',
      payload: { title: 'new session' },
    });

    assert.strictEqual((sent).length, 1);
    assert.strictEqual(sent[0].type, 'tool_error');
    assert.strictEqual(sent[0].reason, undefined);
  });

  test('chat prompt evidence does not collapse to session_not_found', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');
    runtime.actionRouter = {
      route: async () => ({
        success: false,
        errorCode: 'SDK_UNREACHABLE',
        errorMessage: 'Failed to send message',
        errorEvidence: {
          sourceErrorCode: 'session_not_found',
          sourceOperation: 'session.prompt',
        },
      }),
    };

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 's-chat-prompt',
      action: 'chat',
      payload: { toolSessionId: 'tool-chat-prompt', text: 'hello' },
    });

    assert.strictEqual((sent).length, 1);
    assert.strictEqual(sent[0].type, 'tool_error');
    assert.strictEqual(sent[0].reason, undefined);
  });

  test('accepts baseline invoke shape and emits tool_done on chat success', async () => {
    const prompts = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          prompt: async (options) => {
            prompts.push(options);
            return { data: { ok: true } };
          },
        },
      }),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: '100',
      action: 'chat',
      payload: { toolSessionId: 'tool-100', text: 'hello' },
    });

    assert.strictEqual((prompts).length, 1);
    assert.deepStrictEqual(prompts[0], {
      path: { id: 'tool-100' },
      query: { directory: '/session/default-directory' },
      body: {
        parts: [{ type: 'text', text: 'hello' }],
      },
    });
    assert.strictEqual((sent).length, 1);
    assert.strictEqual(sent[0].type, 'tool_done');
    assert.strictEqual(sent[0].toolSessionId, 'tool-100');
    assert.strictEqual(sent[0].welinkSessionId, '100');
  });

  test('intercepts group chat by payload imGroupId and replays synthetic assistant events', async () => {
    const prompts = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          prompt: async (options) => {
            prompts.push(options);
            return { data: { ok: true } };
          },
        },
      }),
    });

    const sent = [];
    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-group-1',
      action: 'chat',
      payload: {
        toolSessionId: 'tool-group-1',
        text: 'hello',
        imGroupId: 'group-1',
      },
    });

    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(sent.length, 10);
    assert.deepStrictEqual(sent.map((entry) => entry.message.type), [
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_done',
    ]);

    const [sessionBusy, messageUpdatedStart, stepStart, textPartStart, textDelta, textPart, stepFinish, messageUpdatedFinish, sessionIdle, toolDone] = sent;
    assert.strictEqual(sessionBusy.message.event.type, 'session.status');
    assert.strictEqual(messageUpdatedStart.message.event.type, 'message.updated');
    assert.strictEqual(stepStart.message.event.type, 'message.part.updated');
    assert.strictEqual(textPartStart.message.event.type, 'message.part.updated');
    assert.strictEqual(textDelta.message.event.type, 'message.part.delta');
    assert.strictEqual(textPart.message.event.type, 'message.part.updated');
    assert.strictEqual(stepFinish.message.event.type, 'message.part.updated');
    assert.strictEqual(messageUpdatedFinish.message.event.type, 'message.updated');
    assert.strictEqual(sessionIdle.message.event.type, 'session.status');
    assert.strictEqual(toolDone.message.type, 'tool_done');

    const startInfo = messageUpdatedStart.message.event.properties.info;
    const finishInfo = messageUpdatedFinish.message.event.properties.info;
    const busyStatus = sessionBusy.message.event.properties;
    const idleStatus = sessionIdle.message.event.properties;
    const stepStartPart = stepStart.message.event.properties.part;
    const textStartPart = textPartStart.message.event.properties.part;
    const textDeltaProps = textDelta.message.event.properties;
    const textReplyPart = textPart.message.event.properties.part;
    const stepFinishPart = stepFinish.message.event.properties.part;
    assert.strictEqual(startInfo.id, finishInfo.id);
    assert.strictEqual(startInfo.sessionID, 'tool-group-1');
    assert.strictEqual(startInfo.role, 'assistant');
    assert.deepStrictEqual(startInfo.time, finishInfo.time);
    assert.strictEqual('finish' in finishInfo, false);
    assert.match(startInfo.id, /^msg_/);
    assert.strictEqual(startInfo.id.includes('tool-group-1'), false);
    assert.strictEqual(busyStatus.sessionID, 'tool-group-1');
    assert.strictEqual(busyStatus.status.type, 'busy');
    assert.strictEqual(idleStatus.sessionID, 'tool-group-1');
    assert.strictEqual(idleStatus.status.type, 'idle');

    assert.strictEqual(stepStartPart.sessionID, 'tool-group-1');
    assert.strictEqual(stepStartPart.messageID, startInfo.id);
    assert.strictEqual(stepStartPart.type, 'step-start');
    assert.notStrictEqual(stepStartPart.id, startInfo.id);
    assert.match(stepStartPart.id, /^prt_/);

    assert.strictEqual(textStartPart.sessionID, 'tool-group-1');
    assert.strictEqual(textStartPart.messageID, startInfo.id);
    assert.strictEqual(textStartPart.type, 'text');
    assert.strictEqual(textStartPart.text, '');
    assert.notStrictEqual(textStartPart.id, startInfo.id);
    assert.match(textStartPart.id, /^prt_/);

    assert.strictEqual(textDeltaProps.sessionID, 'tool-group-1');
    assert.strictEqual(textDeltaProps.messageID, startInfo.id);
    assert.strictEqual(textDeltaProps.partID, textStartPart.id);
    assert.strictEqual(textDeltaProps.field, 'text');
    assert.strictEqual(textDeltaProps.delta, '本机器人不处理群聊消息，请勿在群内@提问');

    assert.strictEqual(textReplyPart.sessionID, 'tool-group-1');
    assert.strictEqual(textReplyPart.messageID, startInfo.id);
    assert.strictEqual(textReplyPart.type, 'text');
    assert.strictEqual(textReplyPart.text, '本机器人不处理群聊消息，请勿在群内@提问');
    assert.strictEqual(textReplyPart.id, textStartPart.id);
    assert.notStrictEqual(textReplyPart.id, startInfo.id);
    assert.match(textReplyPart.id, /^prt_/);

    assert.strictEqual(stepFinishPart.sessionID, 'tool-group-1');
    assert.strictEqual(stepFinishPart.messageID, startInfo.id);
    assert.strictEqual(stepFinishPart.type, 'step-finish');
    assert.strictEqual(stepFinishPart.reason, 'stop');
    assert.notStrictEqual(stepFinishPart.id, startInfo.id);
    assert.match(stepFinishPart.id, /^prt_/);
    assert.notStrictEqual(stepStartPart.id, textStartPart.id);
    assert.notStrictEqual(stepStartPart.id, stepFinishPart.id);
    assert.notStrictEqual(textStartPart.id, stepFinishPart.id);
    assert.strictEqual(stepStartPart.id.includes(startInfo.id), false);
    assert.strictEqual(textStartPart.id.includes(startInfo.id), false);
    assert.strictEqual(stepFinishPart.id.includes(startInfo.id), false);
    assert.strictEqual(toolDone.message.toolSessionId, 'tool-group-1');
    assert.strictEqual(toolDone.message.welinkSessionId, 'wl-group-1');

    for (const entry of sent) {
      const validation = validateGatewayUplinkBusinessMessage(entry.message);
      assert.strictEqual(validation.ok, true);
    }
  });

  test('group chat intercept sends synthetic events immediately without delay', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });

    const sent = [];
    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-group-delay-1',
      action: 'chat',
      payload: {
        toolSessionId: 'tool-group-delay-1',
        text: 'hello',
        imGroupId: 'group-delay-1',
      },
    });

    assert.strictEqual(sent.length, 10);
  });

  test('group chat intercept generates a fresh synthetic message id for each intercepted chat', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });

    const sent = [];
    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-group-repeat-1',
      action: 'chat',
      payload: {
        toolSessionId: 'tool-group-repeat-1',
        text: 'hello',
        imGroupId: 'group-repeat-1',
      },
    });

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-group-repeat-2',
      action: 'chat',
      payload: {
        toolSessionId: 'tool-group-repeat-1',
        text: 'hello again',
        imGroupId: 'group-repeat-1',
      },
    });

    const firstMessageId = sent[1].message.event.properties.info.id;
    const secondMessageId = sent[11].message.event.properties.info.id;
    const firstStepStartPartId = sent[2].message.event.properties.part.id;
    const secondStepStartPartId = sent[12].message.event.properties.part.id;
    const firstTextDeltaPartId = sent[4].message.event.properties.partID;
    const secondTextDeltaPartId = sent[14].message.event.properties.partID;
    assert.notStrictEqual(firstMessageId, secondMessageId);
    assert.match(firstMessageId, /^msg_/);
    assert.match(secondMessageId, /^msg_/);
    assert.strictEqual(firstMessageId.includes('tool-group-repeat-1'), false);
    assert.strictEqual(secondMessageId.includes('tool-group-repeat-1'), false);
    assert.strictEqual(sent[2].message.event.properties.part.messageID, firstMessageId);
    assert.strictEqual(sent[12].message.event.properties.part.messageID, secondMessageId);
    assert.notStrictEqual(firstStepStartPartId, secondStepStartPartId);
    assert.match(firstStepStartPartId, /^prt_/);
    assert.match(secondStepStartPartId, /^prt_/);
    assert.strictEqual(firstStepStartPartId.includes(firstMessageId), false);
    assert.strictEqual(secondStepStartPartId.includes(secondMessageId), false);
    assert.strictEqual(sent[3].message.event.properties.part.id, firstTextDeltaPartId);
    assert.strictEqual(sent[13].message.event.properties.part.id, secondTextDeltaPartId);
  });

  test('intercepts chat by session cache after im-group create_session success', async () => {
    const prompts = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => ({
            data: {
              id: 'tool-group-cache-1',
            },
          }),
          prompt: async (options) => {
            prompts.push(options);
            return { data: { ok: true } };
          },
          delete: async () => ({ data: { id: 'tool-group-cache-1' } }),
        },
      }),
    });

    const sent = [];
    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-create-group-cache',
      action: 'create_session',
      payload: {
        title: 'im-group-xyz',
      },
    });

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chat-group-cache',
      action: 'chat',
      payload: {
        toolSessionId: 'tool-group-cache-1',
        text: 'hello',
      },
    });

    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(sent[0].message.type, 'session_created');
    assert.deepStrictEqual(sent.slice(1).map((entry) => entry.message.type), [
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_done',
    ]);

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-close-group-cache',
      action: 'close_session',
      payload: {
        toolSessionId: 'tool-group-cache-1',
      },
    });

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chat-after-close',
      action: 'chat',
      payload: {
        toolSessionId: 'tool-group-cache-1',
        text: 'hello again',
      },
    });

    assert.strictEqual(prompts.length, 1);
    assert.deepStrictEqual(prompts[0], {
      path: { id: 'tool-group-cache-1' },
      query: { directory: '/session/default-directory' },
      body: {
        parts: [{ type: 'text', text: 'hello again' }],
      },
    });
  });

  test('im-group create_session still seeds session cache when session_created cannot be forwarded', async () => {
    const prompts = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => ({
            data: {
              id: 'tool-group-cache-send-fail-1',
            },
          }),
          prompt: async (options) => {
            prompts.push(options);
            return { data: { ok: true } };
          },
        },
      }),
    });

    const sent = [];
    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    setRuntimeGatewayState(runtime, 'READY');

    const original = runtime.validateGatewayUplinkBusinessMessageOrLog.bind(runtime);
    runtime.validateGatewayUplinkBusinessMessageOrLog = (message, logContext, logger) => {
      if (message.type === 'session_created') {
        return null;
      }
      return original(message, logContext, logger);
    };

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-create-group-cache-send-fail',
      action: 'create_session',
      payload: {
        title: 'im-group-cache-send-fail',
      },
    });

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chat-group-cache-send-fail',
      action: 'chat',
      payload: {
        toolSessionId: 'tool-group-cache-send-fail-1',
        text: 'hello',
      },
    });

    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(sent.some((entry) => entry.message.type === 'session_created'), false);
    assert.deepStrictEqual(sent.map((entry) => entry.message.type), [
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_event',
      'tool_done',
    ]);
  });

  test('group chat intercept does not log replied success when synthetic send fails', async () => {
    const logs = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            logs.push(options);
            return true;
          },
        },
      }),
    });

    runtime.gatewayConnection = {
      send: (message, context) => {
        if (message.type === 'tool_event' && message.event.type === 'message.part.updated') {
          throw new Error('send should not be called after validation failure');
        }
      },
    };
    setRuntimeGatewayState(runtime, 'READY');

    const original = runtime.validateGatewayUplinkBusinessMessageOrLog.bind(runtime);
    let messagePartAttempted = false;
    runtime.validateGatewayUplinkBusinessMessageOrLog = (message, logContext, logger) => {
      if (message.type === 'tool_event' && message.event.type === 'message.part.updated') {
        messagePartAttempted = true;
        return null;
      }
      return original(message, logContext, logger);
    };

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-group-fail-1',
      action: 'chat',
      payload: {
        toolSessionId: 'tool-group-fail-1',
        text: 'hello',
        imGroupId: 'group-fail-1',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(messagePartAttempted, true);
    assert.strictEqual(logs.some((entry) => entry?.body?.message === 'runtime.invoke.chat_group_replied'), false);
    const failedLog = logs.find((entry) => entry?.body?.message === 'runtime.invoke.chat_group_reply_failed');
    assert.ok(failedLog);
    assert.strictEqual(failedLog.body.extra.failedStage, 'tool_event');
  });

  test('group chat intercept suppresses duplicate tool_done when session.idle follows', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });

    const sent = [];
    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    runtime.eventFilter = new EventFilter(['session.idle']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-group-idle-1',
      action: 'chat',
      payload: {
        toolSessionId: 'tool-group-idle-1',
        text: 'hello',
        imGroupId: 'group-idle-1',
      },
    });

    await runtime.handleEvent({
      type: 'session.idle',
      properties: {
        sessionID: 'tool-group-idle-1',
      },
    });

    assert.strictEqual(sent.filter((entry) => entry.message.type === 'tool_done').length, 1);
    assert.strictEqual(sent.filter((entry) => entry.message.type === 'tool_event').length, 10);
    assert.strictEqual(sent[sent.length - 1].message.type, 'tool_event');
    assert.strictEqual(sent[sent.length - 1].message.event.type, 'session.idle');
  });

  test('accepts question_reply invoke shape and routes answer via question API', async () => {
    const getCalls = [];
    const postCalls = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          prompt: async () => ({ data: { ok: true } }),
        },
        _client: {
          get: async (options) => {
            getCalls.push(options);
            return {
              data: [
                {
                  id: 'question-request-42',
                  sessionID: 'tool-42',
                  tool: { callID: 'call-42' },
                },
              ],
            };
          },
          post: async (options) => {
            postCalls.push(options);
            return { data: undefined };
          },
        },
      }),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'q-42',
      action: 'question_reply',
      payload: { toolSessionId: 'tool-42', toolCallId: 'call-42', answer: 'Vite' },
    });

    assert.deepStrictEqual(getCalls, [{
      url: '/question',
      query: {
        directory: '/session/default-directory',
      },
    }]);
    assert.deepStrictEqual(postCalls, [
      {
        url: '/question/{requestID}/reply',
        path: { requestID: 'question-request-42' },
        body: { answers: [['Vite']] },
        headers: { 'Content-Type': 'application/json' },
        query: {
          directory: '/session/default-directory',
        },
      },
    ]);
    assert.strictEqual((sent).length, 0);
  });

  test('accepts question_reply payloads missing toolCallId', async () => {
    const postCalls = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          prompt: async () => ({ data: { ok: true } }),
        },
        _client: {
          get: async () => ({
            data: [
              {
                id: 'question-request-43',
                sessionID: 'tool-43',
              },
            ],
          }),
          post: async (options) => {
            postCalls.push(options);
            return { data: undefined };
          },
        },
      }),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'q-43',
      action: 'question_reply',
      payload: { toolSessionId: 'tool-43', answer: 'Vite' },
    });

    assert.strictEqual((postCalls).length, 1);
    assert.strictEqual((sent).length, 0);
  });

  test('does not emit tool_done on permission_reply success', async () => {
    const permissionCalls = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          prompt: async () => ({ data: { ok: true } }),
        },
        postSessionIdPermissionsPermissionId: async (options) => {
          permissionCalls.push(options);
          return {};
        },
      }),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'perm-1',
      action: 'permission_reply',
      payload: { toolSessionId: 'tool-perm-1', permissionId: 'perm-a', response: 'once' },
    });

    assert.deepStrictEqual(permissionCalls, [
      {
        path: {
          id: 'tool-perm-1',
          permissionID: 'perm-a',
        },
        body: {
          response: 'once',
        },
        query: {
          directory: '/session/default-directory',
        },
      },
    ]);
    assert.strictEqual((sent).length, 0);
  });

  test('rejects question_reply when toolCallId is omitted and pending request is not unique', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          prompt: async () => ({ data: { ok: true } }),
        },
        _client: {
          get: async () => ({
            data: [
              { id: 'question-request-a', sessionID: 'tool-43' },
              { id: 'question-request-b', sessionID: 'tool-43' },
            ],
          }),
          post: async () => ({ data: undefined }),
        },
      }),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'q-43b',
      action: 'question_reply',
      payload: { toolSessionId: 'tool-43', answer: 'Vite' },
    });

    assert.strictEqual((sent).length, 1);
    assert.strictEqual(sent[0].type, 'tool_error');
    assert.ok((sent[0].error).includes('unique pending question'));
  });

  test('rejects question_reply when no pending request matches', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          prompt: async () => ({ data: { ok: true } }),
        },
        _client: {
          get: async () => ({
            data: [
              {
                id: 'question-request-99',
                sessionID: 'tool-other',
                tool: { callID: 'call-other' },
              },
            ],
          }),
          post: async () => ({ data: undefined }),
        },
      }),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'q-46',
      action: 'question_reply',
      payload: { toolSessionId: 'tool-46', toolCallId: 'call-46', answer: 'Vite' },
    });

    assert.strictEqual((sent).length, 1);
    assert.strictEqual(sent[0].type, 'tool_error');
    assert.strictEqual(sent[0].welinkSessionId, 'q-46');
  });

  test('responds to standalone status_query with envelope-free status_response', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'status_query',
    });

    assert.strictEqual((sent).length, 1);
    assert.strictEqual(sent[0].type, 'status_response');
    assert.deepStrictEqual(sent[0], {
      type: 'status_response',
      opencodeOnline: true,
    });
  });

  test('applies config.debug to runtime fallback logging after config load', async () => {
    const debugCalls = [];
    const originalDebug = console.debug;
    console.debug = (...args) => {
      debugCalls.push(args);
    };

    try {
      const runtime = createRuntimeWithResolvedConfig(createResolvedConfig({
        enabled: false,
        debug: true,
        auth: {
          ak: '',
          sk: '',
        },
      }), {
        client: {},
      });

      await assert.rejects(runtime.start(), /message_bridge_runtime_disabled/);

      assert.strictEqual(runtime.getStarted(), false);
      assert.ok(debugCalls.some((args) => args.includes('runtime.start.disabled_by_config')));
    } finally {
      console.debug = originalDebug;
    }
  });

  test('consumes config.debug consistently for runtime debug logs and connection raw frame logs', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const RegisterCaptureWebSocket = createRegisterCaptureWebSocket();
    globalThis.WebSocket = RegisterCaptureWebSocket;

    const logs = [];

    try {
      const runtime = createRuntimeWithResolvedConfig(createResolvedConfig({
        enabled: true,
        debug: true,
      }), {
        client: createRuntimeClient({
          app: {
            log: async (options) => {
              logs.push(options);
              return true;
            },
          },
        }),
      });

      await runtime.start();
      await runtime.handleEvent({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-debug-1',
            sessionID: 'tool-debug-1',
            role: 'user',
          },
        },
      });
      await new Promise((r) => setTimeout(r, 20));

      assert.ok(logs.some((entry) => entry?.body?.level === 'debug' && entry.body.message === 'event.received'));
      assert.ok(
        logs.some(
          (entry) =>
            entry?.body?.level === 'info' &&
            typeof entry.body.message === 'string' &&
            entry.body.message.includes('「sendMessage」===>「{"type":"register"'),
        ),
      );

      runtime.stop();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test('logs event ids, delta bytes, and traceId when forwarding upstream events', async () => {
    const appLogs = [];
    const runtime = new BridgeRuntime({
      client: {
        app: {
          log: async (options) => {
            appLogs.push(options.body);
            return true;
          },
        },
      },
    });

    const sent = [];
    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    runtime.eventFilter = new EventFilter(['message.part.updated']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleEvent({
      type: 'message.part.updated',
      properties: {
        delta: '你好，bridge',
        part: {
          sessionID: 'tool-1',
          messageID: 'op-msg-1',
          id: 'part-1',
          type: 'text',
          text: '你好，bridge',
        },
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    const receivedLog = appLogs.find((entry) => entry.message === 'event.received');
    const forwardingLog = appLogs.find((entry) => entry.message === 'event.forwarding');
    const forwardedLog = appLogs.find((entry) => entry.message === 'event.forwarded');

    assert.strictEqual(receivedLog.extra.traceId, 'op-msg-1');
    assert.notStrictEqual(receivedLog.extra.runtimeTraceId, undefined);
    assert.strictEqual(receivedLog.extra.opencodeMessageId, 'op-msg-1');
    assert.strictEqual(receivedLog.extra.opencodePartId, 'part-1');
    assert.strictEqual(receivedLog.extra.toolSessionId, 'tool-1');
    assert.strictEqual(receivedLog.extra.partType, 'text');
    assert.strictEqual(receivedLog.extra.deltaBytes, Buffer.byteLength('你好，bridge', 'utf8'));

    assert.strictEqual(forwardingLog.extra.toolSessionId, 'tool-1');
    assert.notStrictEqual(forwardingLog.extra.traceId, undefined);
    assert.strictEqual('bridgeMessageId' in forwardingLog.extra, false);
    assert.strictEqual(forwardingLog.extra.opencodeMessageId, 'op-msg-1');
    assert.strictEqual(forwardingLog.extra.opencodePartId, 'part-1');
    assert.strictEqual(forwardedLog.extra.traceId, forwardingLog.extra.traceId);
    assert.strictEqual('bridgeMessageId' in forwardedLog.extra, false);

    assert.strictEqual((sent).length, 1);
    assert.strictEqual(sent[0].context.traceId, forwardingLog.extra.traceId);
    assert.strictEqual(sent[0].context.gatewayMessageId, forwardingLog.extra.traceId);
    assert.strictEqual(sent[0].context.opencodeMessageId, 'op-msg-1');
    assert.strictEqual(sent[0].context.opencodePartId, 'part-1');
  });

  test('forwards bare session.idle as tool_event without emitting fallback tool_done', async () => {
    const runtime = new BridgeRuntime({ client: {} });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    runtime.eventFilter = new EventFilter(['session.idle']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleEvent({
      type: 'session.idle',
      properties: {
        sessionID: 'tool-idle-1',
      },
    });

    assert.strictEqual((sent).length, 1);
    assert.strictEqual(sent[0].message.type, 'tool_event');
    assert.strictEqual(sent[0].message.toolSessionId, 'tool-idle-1');
  });

  test('session.created primes child mapping outside the allowlist and rewrites later child events to parent envelope', async () => {
    const runtime = new BridgeRuntime({ client: createRuntimeClient() });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    runtime.eventFilter = new EventFilter(['permission.asked']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleEvent({
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_child_permission_1',
          parentID: 'ses_parent_permission_1',
          title: 'research-agent',
        },
      },
    });
    await runtime.handleEvent({
      type: 'permission.asked',
      properties: {
        sessionID: 'ses_child_permission_1',
        id: 'perm-child-1',
      },
    });

    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].message, {
      type: 'tool_event',
      toolSessionId: 'ses_parent_permission_1',
      subagentSessionId: 'ses_child_permission_1',
      subagentName: 'research-agent',
      event: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses_child_permission_1',
          id: 'perm-child-1',
        },
      },
    });
    assert.strictEqual(sent[0].context.toolSessionId, 'ses_parent_permission_1');
  });

  test('falls back to original session and retries mapping after lazy lookup failures', async () => {
    const logs = [];
    let calls = 0;
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            logs.push(options);
            return true;
          },
        },
        session: {
          get: async () => {
            calls += 1;
            if (calls === 1) {
              throw new Error('temporary lookup timeout');
            }

            return {
              data: {
                id: 'ses_child_permission_retry',
                directory: '/session/default-directory',
                parentID: 'ses_parent_permission_retry',
                title: 'retry-agent',
              },
            };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    runtime.eventFilter = new EventFilter(['permission.asked']);
    setRuntimeGatewayState(runtime, 'READY');

    const event = {
      type: 'permission.asked',
      properties: {
        sessionID: 'ses_child_permission_retry',
        id: 'perm-retry-1',
      },
    };

    await runtime.handleEvent(event);
    await runtime.handleEvent(event);

    assert.strictEqual(sent.length, 2);
    assert.deepStrictEqual(sent[0].message, {
      type: 'tool_event',
      toolSessionId: 'ses_child_permission_retry',
      event: {
        ...event,
      },
    });
    assert.deepStrictEqual(sent[1].message, {
      type: 'tool_event',
      toolSessionId: 'ses_parent_permission_retry',
      subagentSessionId: 'ses_child_permission_retry',
      subagentName: 'retry-agent',
      event: {
        ...event,
      },
    });
    const warnEntry = logs.find((item) => item?.body?.message === 'event.subagent_lookup_failed');
    assert.ok(!!warnEntry);
    assert.strictEqual(warnEntry.body.extra.toolSessionId, 'ses_child_permission_retry');
  });

  test('child session.idle does not emit tool_done compat messages', async () => {
    const runtime = new BridgeRuntime({ client: createRuntimeClient() });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    runtime.eventFilter = new EventFilter(['session.idle']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleEvent({
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_child_idle_1',
          parentID: 'ses_parent_idle_1',
          title: 'idle-agent',
        },
      },
    });
    await runtime.handleEvent({
      type: 'session.idle',
      properties: {
        sessionID: 'ses_child_idle_1',
      },
    });

    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].message, {
      type: 'tool_event',
      toolSessionId: 'ses_parent_idle_1',
      subagentSessionId: 'ses_child_idle_1',
      subagentName: 'idle-agent',
      event: {
        type: 'session.idle',
        properties: {
          sessionID: 'ses_child_idle_1',
        },
      },
    });
  });

  test('does not emit duplicate tool_done when session.idle follows chat success', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          prompt: async () => ({ data: { ok: true } }),
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    runtime.eventFilter = new EventFilter(['session.idle']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: '42',
      action: 'chat',
      payload: { toolSessionId: 'tool-idle-2', text: 'hello' },
    });

    await runtime.handleEvent({
      type: 'session.idle',
      properties: {
        sessionID: 'tool-idle-2',
      },
    });

    assert.strictEqual((sent.filter((entry) => entry.message.type === 'tool_done')).length, 1);
    assert.strictEqual((sent.filter((entry) => entry.message.type === 'tool_event')).length, 1);
  });

  test('defers session.idle tool_done while chat prompt is still pending', async () => {
    let resolvePrompt;
    const promptPromise = new Promise((resolve) => {
      resolvePrompt = resolve;
    });
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          prompt: async () => {
            await promptPromise;
            return { data: { ok: true } };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    runtime.eventFilter = new EventFilter(['session.idle']);
    setRuntimeGatewayState(runtime, 'READY');

    const invokeTask = runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: '43',
      action: 'chat',
      payload: { toolSessionId: 'tool-idle-3', text: 'hello' },
    });

    await runtime.handleEvent({
      type: 'session.idle',
      properties: {
        sessionID: 'tool-idle-3',
      },
    });

    assert.strictEqual((sent.filter((entry) => entry.message.type === 'tool_done')).length, 0);
    assert.strictEqual((sent.filter((entry) => entry.message.type === 'tool_event')).length, 1);

    resolvePrompt({ data: { ok: true } });
    await invokeTask;

    assert.strictEqual((sent.filter((entry) => entry.message.type === 'tool_done')).length, 1);
  });

  test('does not emit tool_done for close_session success', async () => {
    const deleteCalls = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          delete: async (options) => {
            deleteCalls.push(options);
            return {};
          },
          prompt: async () => ({ data: { ok: true } }),
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'close-1',
      action: 'close_session',
      payload: { toolSessionId: 'tool-close-1' },
    });

    assert.deepStrictEqual(deleteCalls, [{
      path: { id: 'tool-close-1' },
      query: {
        directory: '/session/default-directory',
      },
    }]);
    assert.strictEqual((sent).length, 0);
  });

  test('close_session clears compat state so later session.idle is treated as not started', async () => {
    const appLogs = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            appLogs.push(options.body);
            return true;
          },
        },
        session: {
          prompt: async () => ({ data: { ok: true } }),
          delete: async () => ({}),
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    runtime.eventFilter = new EventFilter(['session.idle']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'close-compat-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-close-compat-1', text: 'hello' },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'close-compat-1',
      action: 'close_session',
      payload: { toolSessionId: 'tool-close-compat-1' },
    });
    await runtime.handleEvent({
      type: 'session.idle',
      properties: {
        sessionID: 'tool-close-compat-1',
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(sent.filter((entry) => entry.message.type === 'tool_done').length, 1);
    assert.strictEqual(sent[sent.length - 1].message.type, 'tool_event');
    assert.strictEqual(sent[sent.length - 1].message.event.type, 'session.idle');
    assert.ok(appLogs.find((entry) => entry.message === 'compat.tool_done.skipped_not_started'));
    assert.strictEqual(appLogs.find((entry) => entry.message === 'compat.tool_done.skipped_duplicate'), undefined);
  });

  test('stop resets compat state so later session.idle is treated as not started', async () => {
    const appLogs = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            appLogs.push(options.body);
            return true;
          },
        },
        session: {
          prompt: async () => ({ data: { ok: true } }),
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    runtime.eventFilter = new EventFilter(['session.idle']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'stop-compat-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-stop-compat-1', text: 'hello' },
    });

    runtime.stop();
    runtime.gatewayConnection = {
      send: (message, context) => sent.push({ message, context }),
    };
    runtime.eventFilter = new EventFilter(['session.idle']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleEvent({
      type: 'session.idle',
      properties: {
        sessionID: 'tool-stop-compat-1',
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(sent.filter((entry) => entry.message.type === 'tool_done').length, 1);
    assert.strictEqual(sent[sent.length - 1].message.type, 'tool_event');
    assert.strictEqual(sent[sent.length - 1].message.event.type, 'session.idle');
    assert.ok(appLogs.find((entry) => entry.message === 'compat.tool_done.skipped_not_started'));
    assert.strictEqual(appLogs.find((entry) => entry.message === 'compat.tool_done.skipped_duplicate'), undefined);
  });

  test('uses effectiveDirectory only in create_session while keeping workspacePath for config lookup', async () => {
    const createCalls = [];
    const promptCalls = [];
    const runtime = createRuntimeWithResolvedConfig(createResolvedConfig(), {
      workspacePath: '/workspace/current',
      hostDirectory: '/workspace/current',
      client: createRuntimeClient({
        session: {
          get: async (options) => ({
            data: {
              id: options?.path?.id ?? 'created-dir-1',
              directory: '/env/bridge-root',
            },
          }),
          create: async (options) => {
            createCalls.push(options);
            return { data: { id: 'created-dir-1' } };
          },
          prompt: async (options) => {
            promptCalls.push(options);
            return { data: { ok: true } };
          },
        },
      }),
    });

    runtime.effectiveDirectory = '/env/bridge-root';
    runtime.gatewayConnection = { send: () => {} };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-create-dir',
      action: 'create_session',
      payload: {
        title: 'Dir session',
      },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chat-dir',
      action: 'chat',
      payload: {
        toolSessionId: 'created-dir-1',
        text: 'hello from bridge directory',
      },
    });

    assert.deepStrictEqual(createCalls, [
      {
        body: {
          title: 'Dir session',
        },
        query: {
          directory: '/env/bridge-root',
        },
      },
    ]);
    assert.deepStrictEqual(promptCalls, [
      {
        path: {
          id: 'created-dir-1',
        },
        query: {
          directory: '/env/bridge-root',
        },
        body: {
          parts: [{ type: 'text', text: 'hello from bridge directory' }],
        },
      },
    ]);
    assert.strictEqual(runtime.workspacePath, '/workspace/current');
  });

  test('runtime.start sends register with runtime-derived metadata', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-runtime-register-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify({
        config_version: 1,
        enabled: true,
        gateway: {
          url: 'ws://localhost:8081/ws/agent',
          deviceName: 'dev',
          macAddress: '11:22:33:44:55:66',
          channel: 'openx',
          toolVersion: '1.2.3',
          heartbeatIntervalMs: 30000,
        reconnect: {
          baseMs: 1000,
          maxMs: 30000,
          exponential: true,
          jitter: 'full',
          maxElapsedMs: 600000,
        },
        },
        sdk: {
          timeoutMs: 10000,
        },
        auth: {
          ak: 'test-ak-001',
          sk: 'test-sk-secret-001',
        },
        events: {
          allowlist: ['message.updated'],
        },
      }),
      'utf8',
    );

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
    const originalNetworkInterfaces = os.networkInterfaces;
    os.networkInterfaces = () => ({
      en0: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '11:22:33:44:55:66',
          internal: false,
          cidr: null,
        },
      ],
    });
    try {
      const runtime = new BridgeRuntime({
        workspacePath: workspace,
        client: createRuntimeClient(),
      });

      await runtime.start();
      await new Promise((r) => setTimeout(r, 10));

      const ws = RegisterCaptureWebSocket.instances[0];
      assert.strictEqual(ws.sent[0].type, 'register');
      assert.strictEqual(ws.sent[0].deviceName, hostname());
      assert.strictEqual(ws.sent[0].macAddress, '11:22:33:44:55:66');
      assert.strictEqual(typeof ws.sent[0].os, 'string');
      assert.strictEqual(ws.sent[0].toolType, 'openx');
      assert.strictEqual(ws.sent[0].toolVersion, '9.9.9');

      runtime.stop();
    } finally {
      os.networkInterfaces = originalNetworkInterfaces;
      globalThis.WebSocket = originalWebSocket;
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('runtime.start logs unknown toolType before register and keeps register payload', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const RegisterCaptureWebSocket = createRegisterCaptureWebSocket();
    globalThis.WebSocket = RegisterCaptureWebSocket;
    const logs = [];

    const resolvedConfig = createResolvedConfig();
    resolvedConfig.gateway.channel = 'legacy-tool-type';

    try {
      const runtime = createRuntimeWithResolvedConfig(resolvedConfig, {
        client: createRuntimeClient({
          app: {
            log: async (options) => {
              logs.push(options);
              return true;
            },
          },
        }),
      });

      await runtime.start();
      await new Promise((r) => setTimeout(r, 20));

      const ws = RegisterCaptureWebSocket.instances[0];
      assert.strictEqual(ws.sent[0].type, 'register');
      assert.strictEqual(ws.sent[0].toolType, 'legacy-tool-type');

      const unknownLog = logs.find((entry) => entry?.body?.message === 'runtime.register.tool_type.unknown');
      assert.ok(unknownLog);
      assert.strictEqual(unknownLog.body.extra.toolType, 'legacy-tool-type');
      assert.deepStrictEqual(unknownLog.body.extra.knownToolTypes, ['openx', 'uniassistant', 'codeagent']);

      runtime.stop();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test('runtime.start omits macAddress when no usable interface is available', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-runtime-register-empty-mac-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    process.env.HOME = fakeHome;

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(
      join(workspace, '.opencode', 'message-bridge.json'),
      JSON.stringify({
        config_version: 1,
        enabled: true,
        gateway: {
          url: 'ws://localhost:8081/ws/agent',
          channel: 'openx',
          heartbeatIntervalMs: 30000,
          reconnect: {
            baseMs: 1000,
            maxMs: 30000,
            exponential: true,
          },
        },
        sdk: {
          timeoutMs: 10000,
        },
        auth: {
          ak: 'test-ak-001',
          sk: 'test-sk-secret-001',
        },
        events: {
          allowlist: ['message.updated'],
        },
      }),
      'utf8',
    );

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
    const originalNetworkInterfaces = os.networkInterfaces;
    os.networkInterfaces = () => ({
      lo0: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: null,
        },
      ],
    });
    try {
      const runtime = new BridgeRuntime({
        workspacePath: workspace,
        client: createRuntimeClient(),
      });

      await runtime.start();
      await new Promise((r) => setTimeout(r, 10));

      const ws = RegisterCaptureWebSocket.instances[0];
      assert.strictEqual('macAddress' in ws.sent[0], false);

      runtime.stop();
    } finally {
      os.networkInterfaces = originalNetworkInterfaces;
      globalThis.WebSocket = originalWebSocket;
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('runtime.start fails on missing sdk capability before connect', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-runtime-start-missing-cap-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    await writeEnabledConfig(workspace);

    const appLogs = [];
    const originalWebSocket = globalThis.WebSocket;
    const RegisterCaptureWebSocket = createRegisterCaptureWebSocket();
    globalThis.WebSocket = RegisterCaptureWebSocket;

    try {
      const runtime = new BridgeRuntime({
        workspacePath: workspace,
        client: createRuntimeClient({
          app: {
            log: async (options) => {
              appLogs.push(options.body);
              return true;
            },
          },
          session: {
            delete: undefined,
          },
        }),
      });

      await assert.rejects(runtime.start(), (err) => { assert.deepStrictEqual(err, {
        code: 'SDK_CLIENT_CAPABILITIES_MISSING',
        message: 'OpenCode client is missing required action capabilities',
        details: {
          missingCapabilities: ['session.delete'],
        },
      }); return true; });
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual((RegisterCaptureWebSocket.instances).length, 0);
      const failureLog = appLogs.find((entry) => entry.message === 'runtime.start.failed_capabilities');
      assert.strictEqual(failureLog.extra.errorCode, 'SDK_CLIENT_CAPABILITIES_MISSING');
      assert.strictEqual(failureLog.extra.errorMessage, 'OpenCode client is missing required action capabilities');
      assert.deepStrictEqual(failureLog.extra.missingCapabilities, ['session.delete']);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      globalThis.WebSocket = originalWebSocket;
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('runtime.start fails when session.get capability is missing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-runtime-start-missing-get-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-runtime-home-missing-get-'));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    await writeEnabledConfig(workspace);

    const appLogs = [];
    try {
      const runtime = new BridgeRuntime({
        workspacePath: workspace,
        client: createRuntimeClient({
          app: {
            log: async (options) => {
              appLogs.push(options.body);
              return true;
            },
          },
          session: {
            get: undefined,
          },
        }),
      });

      await assert.rejects(runtime.start(), (err) => {
        assert.deepStrictEqual(err, {
          code: 'SDK_CLIENT_CAPABILITIES_MISSING',
          message: 'OpenCode client is missing required action capabilities',
          details: {
            missingCapabilities: ['session.get'],
          },
        });
        return true;
      });
      await new Promise((r) => setTimeout(r, 10));

      const failureLog = appLogs.find((entry) => entry.message === 'runtime.start.failed_capabilities');
      assert.deepStrictEqual(failureLog.extra.missingCapabilities, ['session.get']);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('runtime.start falls back to raw /global/health when global.health is unavailable', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-runtime-start-no-health-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    await writeEnabledConfig(workspace);

    const appLogs = [];
    const originalWebSocket = globalThis.WebSocket;
    const RegisterCaptureWebSocket = createRegisterCaptureWebSocket();
    globalThis.WebSocket = RegisterCaptureWebSocket;

    try {
      const runtime = new BridgeRuntime({
        workspacePath: workspace,
        client: createRuntimeClient({
          app: {
            log: async (options) => {
              appLogs.push(options.body);
              return true;
            },
          },
          global: undefined,
        }),
      });

      await runtime.start();
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual((RegisterCaptureWebSocket.instances).length, 1);
      const ws = RegisterCaptureWebSocket.instances[0];
      assert.strictEqual(ws.sent[0].toolVersion, '9.9.9');
      assert.strictEqual(appLogs.find((entry) => entry.message === 'runtime.start.failed_health'), undefined);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      globalThis.WebSocket = originalWebSocket;
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('runtime.start fails when raw /global/health returns without version before connect', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-runtime-start-no-version-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    await writeEnabledConfig(workspace);

    const appLogs = [];
    const originalWebSocket = globalThis.WebSocket;
    const RegisterCaptureWebSocket = createRegisterCaptureWebSocket();
    globalThis.WebSocket = RegisterCaptureWebSocket;

    try {
      const runtime = new BridgeRuntime({
        workspacePath: workspace,
        client: createRuntimeClient({
          app: {
            log: async (options) => {
              appLogs.push(options.body);
              return true;
            },
          },
          global: undefined,
          _client: {
            get: async (options) => {
              if (options?.url === '/global/health') {
                return { data: { healthy: true } };
              }
              return { data: [] };
            },
          },
        }),
      });

      await assert.rejects(runtime.start(), (err) => { assert.deepStrictEqual(err, {
        code: 'GLOBAL_HEALTH_VERSION_MISSING',
        message: 'OpenCode global.health returned without version',
        details: {
          responseShape: 'object:healthy',
        },
      }); return true; });
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual((RegisterCaptureWebSocket.instances).length, 0);
      const failureLog = appLogs.find((entry) => entry.message === 'runtime.start.failed_health_version');
      assert.strictEqual(failureLog.extra.errorCode, 'GLOBAL_HEALTH_VERSION_MISSING');
      assert.strictEqual(failureLog.extra.errorMessage, 'OpenCode global.health returned without version');
      assert.strictEqual(failureLog.extra.responseShape, 'object:healthy');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      globalThis.WebSocket = originalWebSocket;
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('runtime.start fails when raw /global/health throws before register', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-runtime-register-empty-version-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-home-'));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    await writeEnabledConfig(workspace);

    const appLogs = [];
    const originalWebSocket = globalThis.WebSocket;
    const RegisterCaptureWebSocket = createRegisterCaptureWebSocket();

    globalThis.WebSocket = RegisterCaptureWebSocket;
    const originalNetworkInterfaces = os.networkInterfaces;
    os.networkInterfaces = () => ({
      en0: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '11:22:33:44:55:66',
          internal: false,
          cidr: null,
        },
      ],
    });
    try {
      const runtime = new BridgeRuntime({
        workspacePath: workspace,
        client: createRuntimeClient({
          app: {
            log: async (options) => {
              appLogs.push(options.body);
              return true;
            },
          },
          global: undefined,
          _client: {
            get: async () => {
              throw new Error('global unavailable');
            },
          },
        }),
      });

      await assert.rejects(runtime.start(), (err) => { assert.deepStrictEqual(err, {
        code: 'GLOBAL_HEALTH_FAILED',
        message: 'OpenCode global.health check failed during startup',
        details: { cause: 'global unavailable' },
      }); return true; });
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual((RegisterCaptureWebSocket.instances).length, 0);
      const failureLog = appLogs.find((entry) => entry.message === 'runtime.start.failed_health');
      assert.strictEqual(failureLog.extra.errorCode, 'GLOBAL_HEALTH_FAILED');
      assert.strictEqual(failureLog.extra.errorMessage, 'OpenCode global.health check failed during startup');
      assert.strictEqual(failureLog.extra.cause, 'global unavailable');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      os.networkInterfaces = originalNetworkInterfaces;
      globalThis.WebSocket = originalWebSocket;
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('uses gatewayMessageId as traceId across downstream invoke handling', async () => {
    const appLogs = [];
    const runtime = new BridgeRuntime({
      runtimeTraceId: 'runtime-lifecycle-1',
      client: createRuntimeClient({
        app: {
          log: async (options) => {
            appLogs.push(options.body);
            return true;
          },
        },
        session: {
          prompt: async () => ({ data: { ok: true } }),
        },
      }),
    });

    runtime.gatewayConnection = { send: () => {} };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      messageId: 'gw-msg-1',
      action: 'chat',
      welinkSessionId: 'skill-42',
      payload: {
        toolSessionId: 'tool-42',
        text: 'hello',
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    const runtimeInvokeReceived = appLogs.find((entry) => entry.message === 'runtime.invoke.received');
    const routerReceived = appLogs.find((entry) => entry.message === 'router.route.received');
    const actionStarted = appLogs.find((entry) => entry.message === 'action.chat.started');
    const runtimeInvokeCompleted = appLogs.find((entry) => entry.message === 'runtime.invoke.completed');

    assert.strictEqual(runtimeInvokeReceived.extra.traceId, 'gw-msg-1');
    assert.strictEqual(routerReceived.extra.traceId, 'gw-msg-1');
    assert.strictEqual(actionStarted.extra.traceId, 'gw-msg-1');
    assert.strictEqual(runtimeInvokeCompleted.extra.traceId, 'gw-msg-1');

    assert.strictEqual(runtimeInvokeReceived.extra.gatewayMessageId, 'gw-msg-1');
    assert.strictEqual(runtimeInvokeReceived.extra.toolSessionId, 'tool-42');
    assert.strictEqual(runtimeInvokeCompleted.extra.runtimeTraceId, runtimeInvokeReceived.extra.runtimeTraceId);
    assert.strictEqual(runtimeInvokeReceived.extra.runtimeTraceId, 'runtime-lifecycle-1');
    assert.notStrictEqual(runtimeInvokeReceived.extra.runtimeTraceId, 'gw-msg-1');
  });

  test('runtime.start reloads config on restart and uses the latest channel', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const RegisterCaptureWebSocket = createRegisterCaptureWebSocket();
    globalThis.WebSocket = RegisterCaptureWebSocket;

    let resolveCount = 0;
    const configs = [
      createResolvedConfig(),
      createResolvedConfig({
        gateway: {
          ...createResolvedConfig().gateway,
          channel: 'uniassistant',
        },
      }),
    ];

    try {
      const runtime = new (class extends BridgeRuntime {
        async resolveConfig() {
          return configs[resolveCount++];
        }
      })({
        client: createRuntimeClient(),
      });

      await runtime.start();
      await new Promise((r) => setTimeout(r, 10));
      runtime.stop();

      await runtime.start();
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(resolveCount, 2);
      assert.strictEqual(RegisterCaptureWebSocket.instances.length, 2);
      assert.strictEqual(RegisterCaptureWebSocket.instances[0].sent[0].toolType, 'openx');
      assert.strictEqual(RegisterCaptureWebSocket.instances[1].sent[0].toolType, 'uniassistant');

      runtime.stop();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test('runtime.start retries with refreshed config after a pre-open connection failure', async () => {
    const originalWebSocket = globalThis.WebSocket;
    class FlakyRegisterWebSocket {
      static OPEN = 1;
      static instances = [];

      constructor() {
        this.readyState = 0;
        this.sent = [];
        this.instanceIndex = FlakyRegisterWebSocket.instances.push(this) - 1;
        setTimeout(() => {
          if (this.instanceIndex === 0) {
            this.onclose?.({ code: 1006, reason: 'dial failed', wasClean: false });
            return;
          }

          this.readyState = FlakyRegisterWebSocket.OPEN;
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
    globalThis.WebSocket = FlakyRegisterWebSocket;

    let resolveCount = 0;
    const configs = [
      createResolvedConfig(),
      createResolvedConfig({
        gateway: {
          ...createResolvedConfig().gateway,
          channel: 'uniassistant',
        },
      }),
    ];

    try {
      const runtime = new (class extends BridgeRuntime {
        async resolveConfig() {
          return configs[resolveCount++];
        }
      })({
        client: createRuntimeClient(),
      });

      await assert.rejects(runtime.start(), /gateway_websocket_closed_before_open/);
      await runtime.start();
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(resolveCount, 2);
      assert.strictEqual(FlakyRegisterWebSocket.instances.length, 2);
      assert.strictEqual(FlakyRegisterWebSocket.instances[0].sent.length, 0);
      assert.strictEqual(FlakyRegisterWebSocket.instances[1].sent[0].toolType, 'uniassistant');

      runtime.stop();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test('runtime.start applies reconnect env overrides to scheduling and exhaustion behavior', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const originalHome = process.env.HOME;
    const originalJitter = process.env.BRIDGE_GATEWAY_RECONNECT_JITTER;
    const originalMaxElapsed = process.env.BRIDGE_GATEWAY_RECONNECT_MAX_ELAPSED_MS;
    const originalBaseMs = process.env.BRIDGE_GATEWAY_RECONNECT_BASE_MS;
    const originalMaxMs = process.env.BRIDGE_GATEWAY_RECONNECT_MAX_MS;

    class ExhaustingWebSocket {
      static OPEN = 1;
      static instances = [];

      constructor() {
        this.readyState = 0;
        this.sent = [];
        ExhaustingWebSocket.instances.push(this);
        setTimeout(() => {
          this.readyState = ExhaustingWebSocket.OPEN;
          this.onopen?.();
          this.onmessage?.({ data: JSON.stringify({ type: 'register_ok' }) });
          setTimeout(() => {
            this.readyState = 3;
            this.onclose?.({ code: 1006, reason: 'network-loss', wasClean: false });
          }, 0);
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

    globalThis.WebSocket = ExhaustingWebSocket;

    const workspace = await mkdtemp(join(tmpdir(), 'mb-runtime-reconnect-env-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'mb-runtime-reconnect-home-'));
    process.env.HOME = fakeHome;
    process.env.BRIDGE_GATEWAY_RECONNECT_JITTER = 'none';
    process.env.BRIDGE_GATEWAY_RECONNECT_MAX_ELAPSED_MS = '1';
    process.env.BRIDGE_GATEWAY_RECONNECT_BASE_MS = '20';
    process.env.BRIDGE_GATEWAY_RECONNECT_MAX_MS = '20';

    const appLogs = [];

    try {
      await writeEnabledConfig(workspace);

      const runtime = new BridgeRuntime({
        client: createRuntimeClient({
          app: {
            log: async (options) => {
              appLogs.push(options.body);
            },
          },
        }),
        workspacePath: workspace,
      });

      await runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 80));

      const exhausted = appLogs.find((entry) => entry.message === 'gateway.reconnect.exhausted');

      assert.strictEqual(ExhaustingWebSocket.instances.length, 1);
      assert.strictEqual(appLogs.some((entry) => entry.message === 'gateway.reconnect.scheduled'), false);
      assert.ok(exhausted);
      assert.strictEqual(exhausted.extra.maxElapsedMs, 1);

      runtime.stop();
    } finally {
      globalThis.WebSocket = originalWebSocket;
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalJitter === undefined) {
        delete process.env.BRIDGE_GATEWAY_RECONNECT_JITTER;
      } else {
        process.env.BRIDGE_GATEWAY_RECONNECT_JITTER = originalJitter;
      }
      if (originalMaxElapsed === undefined) {
        delete process.env.BRIDGE_GATEWAY_RECONNECT_MAX_ELAPSED_MS;
      } else {
        process.env.BRIDGE_GATEWAY_RECONNECT_MAX_ELAPSED_MS = originalMaxElapsed;
      }
      if (originalBaseMs === undefined) {
        delete process.env.BRIDGE_GATEWAY_RECONNECT_BASE_MS;
      } else {
        process.env.BRIDGE_GATEWAY_RECONNECT_BASE_MS = originalBaseMs;
      }
      if (originalMaxMs === undefined) {
        delete process.env.BRIDGE_GATEWAY_RECONNECT_MAX_MS;
      } else {
        process.env.BRIDGE_GATEWAY_RECONNECT_MAX_MS = originalMaxMs;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test('runtime.start does not inject custom reconnect policy override into gateway client factory', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const RegisterCaptureWebSocket = createRegisterCaptureWebSocket();
    globalThis.WebSocket = RegisterCaptureWebSocket;
    const calls = [];

    try {
      const runtime = new (class extends BridgeRuntime {
        async resolveConfig() {
          return createResolvedConfig();
        }

        createGatewayConnection(options) {
          calls.push({ options });
          return super.createGatewayConnection(options);
        }
      })({
        client: createRuntimeClient(),
      });

      await runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 10));
      runtime.stop();

      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].options.reconnect, createResolvedConfig().gateway.reconnect);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
