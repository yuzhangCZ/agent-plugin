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
  test('reuses effectiveDirectory for create_session and chat without changing workspacePath', async () => {
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
        query: {
          directory: '/bridge/directory',
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

  test('assiant channel resolves mapped directory and forwards assiantId as agent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-assiant-directory-'));
    const mapFile = join(workspace, 'assiant-directory-map.json');
    await writeFile(
      mapFile,
      JSON.stringify({
        'persona-1': '/tenant/persona-1',
      }),
      'utf8',
    );

    const previousChannel = process.env.BRIDGE_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_CHANNEL = 'assiant';
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
          query: {
            directory: '/bridge/directory',
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

  test('assiant channel falls back to effectiveDirectory when map misses and reflects runtime map updates', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mb-assiant-directory-hot-'));
    const mapFile = join(workspace, 'assiant-directory-map.json');
    await writeFile(
      mapFile,
      JSON.stringify({
        'persona-1': '/tenant/persona-1',
      }),
      'utf8',
    );

    const previousChannel = process.env.BRIDGE_CHANNEL;
    const previousMapFile = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE;
    process.env.BRIDGE_CHANNEL = 'assiant';
    process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE = mapFile;

    try {
      const createCalls = [];
      const runtime = new BridgeRuntime({
        workspacePath: '/workspace/current',
        hostDirectory: '/workspace/current',
        client: createRuntimeClient({
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
          'persona-1': '/tenant/persona-1',
          'persona-2': '/tenant/persona-2',
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
