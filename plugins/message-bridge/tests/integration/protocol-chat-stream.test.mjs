import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EventFilter } from '../../src/event/EventFilter.ts';
import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts';
import { setRuntimeGatewayState } from '../helpers/mock-gateway.mjs';

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'opencode-events');

function createRuntimeClient(overrides = {}) {
  const base = {
    global: {},
    session: {
      create: async () => ({ data: { id: 'session-bootstrap-1', directory: '/session/default-directory' } }),
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

function attach(runtime, opencodeSessionId, anchor = opencodeSessionId) {
  runtime.bindingStore.bind(anchor, opencodeSessionId);
  runtime.ownershipResolver.attach(opencodeSessionId, anchor);
}

describe('protocol chat-stream', () => {
  test('forwards stream events as tool_event using protocol fixture payloads', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    runtime.eventFilter = new EventFilter(['message.part.delta', 'message.part.updated']);
    setRuntimeGatewayState(runtime, 'READY');

    const deltaEvent = await loadFixture('message.part.delta.json');
    const updatedEvent = await loadFixture('message.part.updated.text.json');
    attach(runtime, 'ses_fixture_delta');
    attach(runtime, 'ses_32c9fea15ffe2Rnv8tITmfmGmQ');

    await runtime.handleEvent(deltaEvent);
    await runtime.handleEvent(updatedEvent);

    assert.strictEqual(sent.length, 2);
    assert.deepStrictEqual(sent[0], {
        type: 'tool_event',
        toolSessionId: 'ses_fixture_delta',
        event: {
          ...deltaEvent,
        },
    });
    assert.deepStrictEqual(sent[1], {
        type: 'tool_event',
        toolSessionId: 'ses_32c9fea15ffe2Rnv8tITmfmGmQ',
        event: {
          ...updatedEvent,
        },
    });
  });

  test('session.idle stays upstream as tool_event and does not duplicate tool_done after chat success', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    runtime.eventFilter = new EventFilter(['session.idle']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chat-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-chat-1', text: 'hello' },
    });
    const binding = runtime.bindingStore.get('tool-chat-1');
    attach(runtime, binding?.activeOpencodeSessionId ?? 'tool-chat-1', 'tool-chat-1');

    await runtime.handleEvent({
      type: 'session.idle',
      properties: {
        sessionID: binding?.activeOpencodeSessionId ?? 'tool-chat-1',
      },
    });

    assert.strictEqual(sent.filter((message) => message.type === 'tool_done').length, 1);
    assert.deepStrictEqual(sent.filter((message) => message.type === 'tool_event'), [
      {
        type: 'tool_event',
        toolSessionId: 'tool-chat-1',
        event: {
          type: 'session.idle',
          properties: {
            sessionID: binding?.activeOpencodeSessionId ?? 'tool-chat-1',
          },
        },
      },
    ]);
  });
});
