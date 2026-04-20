import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertInvalidInvokeToolErrorContract,
  createInvalidInvokeInboundFrame,
} from '@agent-plugin/test-support/assertions';

import { EventFilter } from '../../src/event/EventFilter.ts';
import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts';
import { setRuntimeGatewayState } from '../helpers/mock-gateway.mjs';

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'opencode-events');

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

async function loadFixture(fileName) {
  const raw = await readFile(join(FIXTURE_DIR, fileName), 'utf8');
  return JSON.parse(raw);
}

describe('protocol permission-roundtrip', () => {
  test('forwards permission.replied as tool_event', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    runtime.eventFilter = new EventFilter(['permission.replied']);
    setRuntimeGatewayState(runtime, 'READY');

    const permissionRepliedEvent = await loadFixture('permission.replied.json');
    await runtime.handleEvent(permissionRepliedEvent);

    assert.deepStrictEqual(sent, [
      {
        type: 'tool_event',
        toolSessionId: 'ses_permission_1',
        event: {
          family: 'opencode',
          ...permissionRepliedEvent,
        },
      },
    ]);
  });

  test('forwards permission.asked as tool_event and routes permission_reply to SDK', async () => {
    const permissionCalls = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        postSessionIdPermissionsPermissionId: async (options) => {
          permissionCalls.push(options);
          return {};
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    runtime.eventFilter = new EventFilter(['permission.asked']);
    setRuntimeGatewayState(runtime, 'READY');

    const permissionAskedEvent = await loadFixture('permission.asked.json');
    await runtime.handleEvent(permissionAskedEvent);

    assert.deepStrictEqual(sent, [
      {
        type: 'tool_event',
        toolSessionId: 'ses_permission_1',
        event: {
          family: 'opencode',
          type: 'permission.asked',
          properties: {
            id: 'perm_fixture_1',
            sessionID: 'ses_permission_1',
            messageID: 'msg_permission_1',
            type: 'exec',
            title: 'Run command',
            metadata: {
              command: 'ls',
            },
          },
        },
      },
    ]);

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-perm-1',
      action: 'permission_reply',
      payload: {
        toolSessionId: 'ses_permission_1',
        permissionId: 'perm_fixture_1',
        response: 'always',
      },
    });

    assert.deepStrictEqual(permissionCalls, [
      {
        path: {
          id: 'ses_permission_1',
          permissionID: 'perm_fixture_1',
        },
        body: {
          response: 'always',
        },
        query: {
          directory: '/session/default-directory',
        },
      },
    ]);
    assert.strictEqual(sent.length, 1);
  });

  test('returns tool_error when invalid permission_reply invoke is rejected before runtime dispatch', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    setRuntimeGatewayState(runtime, 'READY');

    runtime.handleInboundFrame(
      createInvalidInvokeInboundFrame({
        action: 'permission_reply',
        welinkSessionId: 'wl-perm-invalid',
        toolSessionId: 'ses_permission_1',
        violation: {
          violation: {
            stage: 'payload',
            code: 'invalid_field_value',
            field: 'payload.response',
            message: 'payload.response is invalid',
            messageType: 'invoke',
            action: 'permission_reply',
            welinkSessionId: 'wl-perm-invalid',
            toolSessionId: 'ses_permission_1',
          },
        },
        rawPreview: {
          type: 'invoke',
          welinkSessionId: 'wl-perm-invalid',
          action: 'permission_reply',
          payload: {
            toolSessionId: 'ses_permission_1',
            permissionId: 'perm_fixture_1',
            response: 'allow',
          },
        },
      }),
    );

    assert.strictEqual(sent.length, 1);
    assertInvalidInvokeToolErrorContract(sent[0], {
      code: 'invalid_field_value',
      welinkSessionId: 'wl-perm-invalid',
      toolSessionId: 'ses_permission_1',
    });
  });
});
