import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts';

function createRuntimeClient(overrides = {}) {
  const base = {
    global: {},
    session: {
      create: async () => ({}),
      abort: async () => ({}),
      delete: async () => ({}),
      prompt: async () => ({ data: { ok: true } }),
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
    session: {
      ...base.session,
      ...(overrides.session ?? {}),
    },
    _client: {
      ...base._client,
      ...(overrides._client ?? {}),
    },
  };
}

function setRuntimeChannel(runtime, channel) {
  runtime.bridgeChannelPort.setChannel(channel);
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

describe('protocol directory-context integration', () => {
  test('uses effectiveDirectory for create_session only without changing workspacePath', async () => {
    const createCalls = [];
    const promptCalls = [];
    const runtime = new BridgeRuntime({
      workspacePath: '/workspace/current',
      hostDirectory: '/workspace/current',
      client: createRuntimeClient({
        session: {
          create: async (options) => {
            createCalls.push(options);
            return { data: { id: 'dir-session-1' } };
          },
          prompt: async (options) => {
            promptCalls.push(options);
            return { data: { ok: true } };
          },
        },
      }),
    });
    const sent = [];

    runtime.effectiveDirectory = '/bridge/directory';
    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    runtime.stateManager.setState('READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-dir-1',
      action: 'create_session',
      payload: {
        title: 'Directory integration session',
      },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-dir-2',
      action: 'chat',
      payload: {
        toolSessionId: 'dir-session-1',
        text: 'hello directory',
      },
    });

    assert.deepStrictEqual(createCalls, [
      {
        body: {
          title: 'Directory integration session',
        },
        query: {
          directory: '/bridge/directory',
        },
      },
    ]);
    assert.deepStrictEqual(promptCalls, [
      {
        path: {
          id: 'dir-session-1',
        },
        body: {
          parts: [{ type: 'text', text: 'hello directory' }],
        },
      },
    ]);
    assert.strictEqual(runtime.workspacePath, '/workspace/current');
    assert.deepStrictEqual(sent[0], {
      type: 'session_created',
      welinkSessionId: 'wl-dir-1',
      toolSessionId: 'dir-session-1',
      session: {
        sessionId: 'dir-session-1',
        session: {
          id: 'dir-session-1',
        },
      },
    });
    assert.strictEqual(sent[1].type, 'tool_done');
    assert.strictEqual(sent[1].toolSessionId, 'dir-session-1');
  });

  test('only create_session carries directory across create/chat/abort/permission/question/close', async () => {
    const createCalls = [];
    const promptCalls = [];
    const abortCalls = [];
    const deleteCalls = [];
    const permissionCalls = [];
    const getCalls = [];
    const postCalls = [];
    const runtime = new BridgeRuntime({
      workspacePath: '/workspace/current',
      hostDirectory: '/workspace/current',
      client: createRuntimeClient({
        session: {
          create: async (options) => {
            createCalls.push(options);
            return { data: { id: 'dir-chain-1' } };
          },
          prompt: async (options) => {
            promptCalls.push(options);
            return { data: { ok: true } };
          },
          abort: async (options) => {
            abortCalls.push(options);
            return { data: { ok: true } };
          },
          delete: async (options) => {
            deleteCalls.push(options);
            return { data: { ok: true } };
          },
        },
        postSessionIdPermissionsPermissionId: async (options) => {
          permissionCalls.push(options);
          return { data: { ok: true } };
        },
        _client: {
          get: async (options) => {
            getCalls.push(options);
            if (options?.url === '/global/health') {
              return { data: { healthy: true, version: '9.9.9' } };
            }
            return {
              data: [
                {
                  id: 'question-request-1',
                  sessionID: 'dir-chain-1',
                  tool: { callID: 'call-1' },
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

    runtime.effectiveDirectory = '/bridge/directory';
    runtime.gatewayConnection = {
      send: () => {},
    };
    runtime.stateManager.setState('READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chain-create',
      action: 'create_session',
      payload: {
        title: 'Directory chain',
      },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chain-chat',
      action: 'chat',
      payload: {
        toolSessionId: 'dir-chain-1',
        text: 'hello chain',
      },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chain-abort',
      action: 'abort_session',
      payload: {
        toolSessionId: 'dir-chain-1',
      },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chain-permission',
      action: 'permission_reply',
      payload: {
        toolSessionId: 'dir-chain-1',
        permissionId: 'perm-1',
        response: 'once',
      },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chain-question',
      action: 'question_reply',
      payload: {
        toolSessionId: 'dir-chain-1',
        toolCallId: 'call-1',
        answer: 'yes',
      },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chain-close',
      action: 'close_session',
      payload: {
        toolSessionId: 'dir-chain-1',
      },
    });

    assert.deepStrictEqual(createCalls, [
      {
        body: {
          title: 'Directory chain',
        },
        query: {
          directory: '/bridge/directory',
        },
      },
    ]);
    assert.deepStrictEqual(promptCalls, [
      {
        path: {
          id: 'dir-chain-1',
        },
        body: {
          parts: [{ type: 'text', text: 'hello chain' }],
        },
      },
    ]);
    assert.deepStrictEqual(abortCalls, [
      {
        path: {
          id: 'dir-chain-1',
        },
      },
    ]);
    assert.deepStrictEqual(deleteCalls, [
      {
        path: {
          id: 'dir-chain-1',
        },
      },
    ]);
    assert.deepStrictEqual(permissionCalls, [
      {
        path: {
          id: 'dir-chain-1',
          permissionID: 'perm-1',
        },
        body: {
          response: 'once',
        },
      },
    ]);
    assert.deepStrictEqual(getCalls, [{ url: '/question' }]);
    assert.deepStrictEqual(postCalls, [
      {
        url: '/question/{requestID}/reply',
        path: { requestID: 'question-request-1' },
        body: { answers: [['yes']] },
        headers: { 'Content-Type': 'application/json' },
      },
    ]);
  });

  test('uniassistant channel resolves mapped directory and forwards assistantId as agent without chat directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-assiant-directory-'));
    const mapFile = join(workspace, 'assiant-directory-map.json');
    const configDir = join(workspace, '.opencode');
    const originalWebSocket = globalThis.WebSocket;
    const RegisterCaptureWebSocket = createRegisterCaptureWebSocket();
    globalThis.WebSocket = RegisterCaptureWebSocket;
    await writeFile(
      mapFile,
      JSON.stringify({
        'persona-1': {
          directory: '/tenant/persona-1',
        },
      }),
      'utf8',
    );
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'message-bridge.json'),
      JSON.stringify({
        config_version: 1,
        enabled: true,
        gateway: {
          url: 'ws://localhost:8081/ws/agent',
          channel: 'uniassistant',
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
          ak: 'test-ak',
          sk: 'test-sk',
        },
        events: {
          allowlist: ['message.updated'],
        },
      }),
      'utf8',
    );

    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    const previousChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
    delete process.env.BRIDGE_GATEWAY_CHANNEL;
    process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = mapFile;

    try {
      const createCalls = [];
      const promptCalls = [];
      const runtime = new BridgeRuntime({
        workspacePath: workspace,
        hostDirectory: '/bridge/directory',
        client: createRuntimeClient({
          session: {
            create: async (options) => {
              createCalls.push(options);
              return { data: { id: 'dir-assiant-1' } };
            },
            prompt: async (options) => {
              promptCalls.push(options);
              return { data: { ok: true } };
            },
          },
        }),
      });
      await runtime.start();
      await new Promise((r) => setTimeout(r, 10));

      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-create',
        action: 'create_session',
        payload: {
          title: 'Assiant session',
          assistantId: 'persona-1',
        },
      });
      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-chat',
        action: 'chat',
        payload: {
          toolSessionId: 'dir-assiant-1',
          text: 'hello assiant',
          assistantId: 'persona-1',
        },
      });

      assert.deepStrictEqual(createCalls, [
        {
          body: {
            title: 'Assiant session',
          },
          query: {
            directory: '/tenant/persona-1',
          },
        },
      ]);
      assert.deepStrictEqual(promptCalls, [
        {
          path: {
            id: 'dir-assiant-1',
          },
          body: {
            agent: 'persona-1',
            parts: [{ type: 'text', text: 'hello assiant' }],
          },
        },
      ]);
      const ws = RegisterCaptureWebSocket.instances[0];
      assert.strictEqual(ws.sent[0].type, 'register');
      assert.strictEqual(ws.sent[0].toolType, 'uniassistant');
      assert.strictEqual(ws.sent[1].type, 'session_created');
      assert.strictEqual(ws.sent[1].toolSessionId, 'dir-assiant-1');
      assert.strictEqual(ws.sent[2].type, 'tool_done');
      assert.strictEqual(ws.sent[2].toolSessionId, 'dir-assiant-1');

      runtime.stop();
    } finally {
      globalThis.WebSocket = originalWebSocket;
      if (previousChannel === undefined) {
        delete process.env.BRIDGE_GATEWAY_CHANNEL;
      } else {
        process.env.BRIDGE_GATEWAY_CHANNEL = previousChannel;
      }
      if (previousMapFile === undefined) {
        delete process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
      } else {
        process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = previousMapFile;
      }
    }
  });

  test('uniassistant channel ignores legacy assiantId and falls back to existing defaults', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-assiant-legacy-field-'));
    const mapFile = join(workspace, 'assiant-directory-map.json');
    await writeFile(
      mapFile,
      JSON.stringify({
        'persona-1': {
          directory: '/tenant/persona-1',
        },
      }),
      'utf8',
    );

    const previousChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_GATEWAY_CHANNEL = 'uniassistant';
    process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = mapFile;

    try {
      const createCalls = [];
      const promptCalls = [];
      const runtime = new BridgeRuntime({
        workspacePath: '/workspace/current',
        hostDirectory: '/workspace/current',
        client: createRuntimeClient({
          session: {
            create: async (options) => {
              createCalls.push(options);
              return { data: { id: 'dir-assiant-legacy-1' } };
            },
            prompt: async (options) => {
              promptCalls.push(options);
              return { data: { ok: true } };
            },
          },
        }),
      });
      setRuntimeChannel(runtime, 'uniassistant');

      runtime.effectiveDirectory = '/bridge/directory';
      runtime.gatewayConnection = {
        send: () => {},
      };
      runtime.stateManager.setState('READY');

      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-legacy-create',
        action: 'create_session',
        payload: {
          title: 'Legacy assiant session',
          assiantId: 'persona-1',
        },
      });
      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-legacy-chat',
        action: 'chat',
        payload: {
          toolSessionId: 'dir-assiant-legacy-1',
          text: 'hello legacy assiant',
          assiantId: 'persona-1',
        },
      });

      assert.deepStrictEqual(createCalls, [
        {
          body: {
            title: 'Legacy assiant session',
          },
          query: {
            directory: '/bridge/directory',
          },
        },
      ]);
      assert.deepStrictEqual(promptCalls, [
        {
          path: {
            id: 'dir-assiant-legacy-1',
          },
          body: {
            parts: [{ type: 'text', text: 'hello legacy assiant' }],
          },
        },
      ]);
    } finally {
      if (previousChannel === undefined) {
        delete process.env.BRIDGE_GATEWAY_CHANNEL;
      } else {
        process.env.BRIDGE_GATEWAY_CHANNEL = previousChannel;
      }
      if (previousMapFile === undefined) {
        delete process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
      } else {
        process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = previousMapFile;
      }
    }
  });

  test('uniassistant channel only applies mapped directory in create_session across full action chain', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-assiant-directory-chain-'));
    const mapFile = join(workspace, 'assiant-directory-map.json');
    await writeFile(
      mapFile,
      JSON.stringify({
        'persona-1': {
          directory: '/tenant/persona-1',
        },
      }),
      'utf8',
    );

    const previousChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_GATEWAY_CHANNEL = 'uniassistant';
    process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = mapFile;

    try {
      const createCalls = [];
      const promptCalls = [];
      const abortCalls = [];
      const deleteCalls = [];
      const permissionCalls = [];
      const getCalls = [];
      const postCalls = [];
      const runtime = new BridgeRuntime({
        workspacePath: '/workspace/current',
        hostDirectory: '/workspace/current',
        client: createRuntimeClient({
          session: {
            create: async (options) => {
              createCalls.push(options);
              return { data: { id: 'dir-assiant-chain-1' } };
            },
            prompt: async (options) => {
              promptCalls.push(options);
              return { data: { ok: true } };
            },
            abort: async (options) => {
              abortCalls.push(options);
              return { data: { ok: true } };
            },
            delete: async (options) => {
              deleteCalls.push(options);
              return { data: { ok: true } };
            },
          },
          postSessionIdPermissionsPermissionId: async (options) => {
            permissionCalls.push(options);
            return { data: { ok: true } };
          },
          _client: {
            get: async (options) => {
              getCalls.push(options);
              if (options?.url === '/global/health') {
                return { data: { healthy: true, version: '9.9.9' } };
              }
              return {
                data: [
                  {
                    id: 'question-assiant-request-1',
                    sessionID: 'dir-assiant-chain-1',
                    tool: { callID: 'call-assiant-1' },
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
      setRuntimeChannel(runtime, 'uniassistant');

      runtime.effectiveDirectory = '/bridge/directory';
      runtime.gatewayConnection = {
        send: () => {},
      };
      runtime.stateManager.setState('READY');

      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-chain-create',
        action: 'create_session',
        payload: {
          title: 'Assiant chain session',
          assistantId: 'persona-1',
        },
      });
      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-chain-chat',
        action: 'chat',
        payload: {
          toolSessionId: 'dir-assiant-chain-1',
          text: 'hello assiant chain',
          assistantId: 'persona-1',
        },
      });
      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-chain-abort',
        action: 'abort_session',
        payload: {
          toolSessionId: 'dir-assiant-chain-1',
        },
      });
      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-chain-permission',
        action: 'permission_reply',
        payload: {
          toolSessionId: 'dir-assiant-chain-1',
          permissionId: 'perm-assiant-1',
          response: 'always',
        },
      });
      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-chain-question',
        action: 'question_reply',
        payload: {
          toolSessionId: 'dir-assiant-chain-1',
          toolCallId: 'call-assiant-1',
          answer: 'agree',
        },
      });
      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-chain-close',
        action: 'close_session',
        payload: {
          toolSessionId: 'dir-assiant-chain-1',
        },
      });

      assert.deepStrictEqual(createCalls, [
        {
          body: {
            title: 'Assiant chain session',
          },
          query: {
            directory: '/tenant/persona-1',
          },
        },
      ]);
      assert.deepStrictEqual(promptCalls, [
        {
          path: {
            id: 'dir-assiant-chain-1',
          },
          body: {
            agent: 'persona-1',
            parts: [{ type: 'text', text: 'hello assiant chain' }],
          },
        },
      ]);
      assert.deepStrictEqual(abortCalls, [
        {
          path: {
            id: 'dir-assiant-chain-1',
          },
        },
      ]);
      assert.deepStrictEqual(deleteCalls, [
        {
          path: {
            id: 'dir-assiant-chain-1',
          },
        },
      ]);
      assert.deepStrictEqual(permissionCalls, [
        {
          path: {
            id: 'dir-assiant-chain-1',
            permissionID: 'perm-assiant-1',
          },
          body: {
            response: 'always',
          },
        },
      ]);
      assert.deepStrictEqual(getCalls, [{ url: '/question' }]);
      assert.deepStrictEqual(postCalls, [
        {
          url: '/question/{requestID}/reply',
          path: { requestID: 'question-assiant-request-1' },
          body: { answers: [['agree']] },
          headers: { 'Content-Type': 'application/json' },
        },
      ]);
    } finally {
      if (previousChannel === undefined) {
        delete process.env.BRIDGE_GATEWAY_CHANNEL;
      } else {
        process.env.BRIDGE_GATEWAY_CHANNEL = previousChannel;
      }
      if (previousMapFile === undefined) {
        delete process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
      } else {
        process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = previousMapFile;
      }
    }
  });

  test('uniassistant channel falls back to effectiveDirectory when map misses and reflects runtime map updates', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-assiant-directory-hot-'));
    const mapFile = join(workspace, 'assiant-directory-map.json');
    await writeFile(mapFile, JSON.stringify({ 'persona-1': '/tenant/persona-1' }), 'utf8');

    const previousChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_GATEWAY_CHANNEL = 'uniassistant';
    process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = mapFile;

    try {
      const createCalls = [];
      const logCalls = [];
      const runtime = new BridgeRuntime({
        workspacePath: '/workspace/current',
        hostDirectory: '/workspace/current',
        client: createRuntimeClient({
          app: {
            log: async (options) => {
              logCalls.push(options);
              return true;
            },
          },
          session: {
            create: async (options) => {
              createCalls.push(options);
              return { data: { id: `dir-assiant-${createCalls.length}` } };
            },
          },
        }),
      });
      setRuntimeChannel(runtime, 'uniassistant');

      runtime.effectiveDirectory = '/bridge/directory';
      runtime.gatewayConnection = {
        send: () => {},
      };
      runtime.stateManager.setState('READY');

      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-miss',
        action: 'create_session',
        payload: {
          title: 'Assiant miss session',
          assistantId: 'persona-2',
        },
      });

      await writeFile(
        mapFile,
        JSON.stringify({
          'persona-1': {
            directory: '/tenant/persona-1',
          },
          'persona-2': {
            directory: '/tenant/persona-2',
          },
        }),
        'utf8',
      );

      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-hit-after-update',
        action: 'create_session',
        payload: {
          title: 'Assiant hit session',
          assistantId: 'persona-2',
        },
      });

      assert.deepStrictEqual(createCalls, [
        {
          body: {
            title: 'Assiant miss session',
          },
          query: {
            directory: '/bridge/directory',
          },
        },
        {
          body: {
            title: 'Assiant hit session',
          },
          query: {
            directory: '/tenant/persona-2',
          },
        },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const unresolvedWarnings = logCalls.filter((call) => call.body?.message === 'assiant.directory_map.unresolved');
      assert.strictEqual(unresolvedWarnings.length, 1);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.reason, 'directory_unresolved');
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.channel, 'uniassistant');
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.assistantId, 'persona-2');
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.mappingConfigured, true);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.hasEffectiveDirectory, true);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.fallbackSource, 'effective');
      const invalidEntryWarnings = logCalls.filter((call) => call.body?.message === 'assiant.directory_map.invalid_entry');
      assert.strictEqual(invalidEntryWarnings.length, 1);
      assert.deepStrictEqual(invalidEntryWarnings[0].body?.extra?.assiantId, 'persona-1');
      assert.deepStrictEqual(invalidEntryWarnings[0].body?.extra?.entryType, 'string');
      assert.deepStrictEqual(invalidEntryWarnings[0].body?.extra?.isLegacyFlatString, true);
    } finally {
      if (previousChannel === undefined) {
        delete process.env.BRIDGE_GATEWAY_CHANNEL;
      } else {
        process.env.BRIDGE_GATEWAY_CHANNEL = previousChannel;
      }
      if (previousMapFile === undefined) {
        delete process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
      } else {
        process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = previousMapFile;
      }
    }
  });

  test('uniassistant channel warns when create_session payload misses assistantId', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-assiant-directory-missing-agent-'));
    const mapFile = join(workspace, 'assiant-directory-map.json');
    await writeFile(
      mapFile,
      JSON.stringify({
        'persona-1': {
          directory: '/tenant/persona-1',
        },
      }),
      'utf8',
    );

    const previousChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_GATEWAY_CHANNEL = 'uniassistant';
    process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = mapFile;

    try {
      const createCalls = [];
      const logCalls = [];
      const runtime = new BridgeRuntime({
        workspacePath: '/workspace/current',
        hostDirectory: '/workspace/current',
        client: createRuntimeClient({
          app: {
            log: async (options) => {
              logCalls.push(options);
              return true;
            },
          },
          session: {
            create: async (options) => {
              createCalls.push(options);
              return { data: { id: 'dir-assiant-missing-agent' } };
            },
          },
        }),
      });
      setRuntimeChannel(runtime, 'uniassistant');

      runtime.effectiveDirectory = '/bridge/directory';
      runtime.gatewayConnection = {
        send: () => {},
      };
      runtime.stateManager.setState('READY');

      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-missing-agent',
        action: 'create_session',
        payload: {
          title: 'Assiant missing agent session',
        },
      });

      assert.deepStrictEqual(createCalls, [
        {
          body: {
            title: 'Assiant missing agent session',
          },
          query: {
            directory: '/bridge/directory',
          },
        },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const unresolvedWarnings = logCalls.filter((call) => call.body?.message === 'assiant.directory_map.unresolved');
      assert.strictEqual(unresolvedWarnings.length, 1);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.reason, 'missing_assiant_id');
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.channel, 'uniassistant');
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.assistantId, undefined);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.mappingConfigured, true);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.hasEffectiveDirectory, true);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.fallbackSource, 'effective');
    } finally {
      if (previousChannel === undefined) {
        delete process.env.BRIDGE_GATEWAY_CHANNEL;
      } else {
        process.env.BRIDGE_GATEWAY_CHANNEL = previousChannel;
      }
      if (previousMapFile === undefined) {
        delete process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
      } else {
        process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = previousMapFile;
      }
    }
  });

  test('uniassistant channel warns when mapping file is not configured', async () => {
    const previousChannel = process.env.BRIDGE_GATEWAY_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_GATEWAY_CHANNEL = 'uniassistant';
    delete process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;

    try {
      const createCalls = [];
      const logCalls = [];
      const runtime = new BridgeRuntime({
        workspacePath: '/workspace/current',
        hostDirectory: '/workspace/current',
        client: createRuntimeClient({
          app: {
            log: async (options) => {
              logCalls.push(options);
              return true;
            },
          },
          session: {
            create: async (options) => {
              createCalls.push(options);
              return { data: { id: 'dir-assiant-no-map-file' } };
            },
          },
        }),
      });
      setRuntimeChannel(runtime, 'uniassistant');

      runtime.effectiveDirectory = '/bridge/directory';
      runtime.gatewayConnection = {
        send: () => {},
      };
      runtime.stateManager.setState('READY');

      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-no-map-file',
        action: 'create_session',
        payload: {
          title: 'Assiant no map file session',
          assistantId: 'persona-no-map',
        },
      });

      assert.deepStrictEqual(createCalls, [
        {
          body: {
            title: 'Assiant no map file session',
          },
          query: {
            directory: '/bridge/directory',
          },
        },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const unresolvedWarnings = logCalls.filter((call) => call.body?.message === 'assiant.directory_map.unresolved');
      assert.strictEqual(unresolvedWarnings.length, 1);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.reason, 'mapping_file_unconfigured');
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.channel, 'uniassistant');
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.assistantId, 'persona-no-map');
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.mappingConfigured, false);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.hasEffectiveDirectory, true);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.fallbackSource, 'effective');
    } finally {
      if (previousChannel === undefined) {
        delete process.env.BRIDGE_GATEWAY_CHANNEL;
      } else {
        process.env.BRIDGE_GATEWAY_CHANNEL = previousChannel;
      }
      if (previousMapFile === undefined) {
        delete process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
      } else {
        process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = previousMapFile;
      }
    }
  });
});
