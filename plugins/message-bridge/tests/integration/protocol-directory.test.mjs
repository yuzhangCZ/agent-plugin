import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

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
});
