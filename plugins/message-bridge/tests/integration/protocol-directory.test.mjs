import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
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

  test('uniassistant channel resolves mapped directory and forwards assiantId as agent without chat directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-assiant-directory-'));
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

    const previousChannel = process.env.BRIDGE_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_CHANNEL = 'uniassistant';
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
              return { data: { id: 'dir-assiant-1' } };
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
        welinkSessionId: 'wl-assiant-create',
        action: 'create_session',
        payload: {
          title: 'Assiant session',
          assiantId: 'persona-1',
        },
      });
      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-chat',
        action: 'chat',
        payload: {
          toolSessionId: 'dir-assiant-1',
          text: 'hello assiant',
          assiantId: 'persona-1',
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
      assert.strictEqual(sent[0].type, 'session_created');
      assert.strictEqual(sent[0].toolSessionId, 'dir-assiant-1');
      assert.strictEqual(sent[1].type, 'tool_done');
      assert.strictEqual(sent[1].toolSessionId, 'dir-assiant-1');
    } finally {
      if (previousChannel === undefined) {
        delete process.env.BRIDGE_CHANNEL;
      } else {
        process.env.BRIDGE_CHANNEL = previousChannel;
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

    const previousChannel = process.env.BRIDGE_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_CHANNEL = 'uniassistant';
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
          assiantId: 'persona-1',
        },
      });
      await runtime.handleDownstreamMessage({
        type: 'invoke',
        welinkSessionId: 'wl-assiant-chain-chat',
        action: 'chat',
        payload: {
          toolSessionId: 'dir-assiant-chain-1',
          text: 'hello assiant chain',
          assiantId: 'persona-1',
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
        delete process.env.BRIDGE_CHANNEL;
      } else {
        process.env.BRIDGE_CHANNEL = previousChannel;
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

    const previousChannel = process.env.BRIDGE_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_CHANNEL = 'uniassistant';
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
          assiantId: 'persona-2',
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
          assiantId: 'persona-2',
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
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.assiantId, 'persona-2');
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
        delete process.env.BRIDGE_CHANNEL;
      } else {
        process.env.BRIDGE_CHANNEL = previousChannel;
      }
      if (previousMapFile === undefined) {
        delete process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
      } else {
        process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = previousMapFile;
      }
    }
  });

  test('uniassistant channel warns when create_session payload misses assiantId', async () => {
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

    const previousChannel = process.env.BRIDGE_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_CHANNEL = 'uniassistant';
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
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.mappingConfigured, true);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.hasEffectiveDirectory, true);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.fallbackSource, 'effective');
    } finally {
      if (previousChannel === undefined) {
        delete process.env.BRIDGE_CHANNEL;
      } else {
        process.env.BRIDGE_CHANNEL = previousChannel;
      }
      if (previousMapFile === undefined) {
        delete process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
      } else {
        process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = previousMapFile;
      }
    }
  });

  test('uniassistant channel warns when mapping file is not configured', async () => {
    const previousChannel = process.env.BRIDGE_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_CHANNEL = 'uniassistant';
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
          assiantId: 'persona-no-map',
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
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.assiantId, 'persona-no-map');
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.mappingConfigured, false);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.hasEffectiveDirectory, true);
      assert.deepStrictEqual(unresolvedWarnings[0].body?.extra?.fallbackSource, 'effective');
    } finally {
      if (previousChannel === undefined) {
        delete process.env.BRIDGE_CHANNEL;
      } else {
        process.env.BRIDGE_CHANNEL = previousChannel;
      }
      if (previousMapFile === undefined) {
        delete process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
      } else {
        process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = previousMapFile;
      }
    }
  });
});
