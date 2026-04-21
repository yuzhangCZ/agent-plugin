import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EventFilter } from '../../src/event/EventFilter.ts';
import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts';

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
    runtime.stateManager.setState('READY');

    const deltaEvent = await loadFixture('message.part.delta.json');
    const updatedEvent = await loadFixture('message.part.updated.text.json');

    await runtime.handleEvent(deltaEvent);
    await runtime.handleEvent(updatedEvent);

    assert.strictEqual(sent.length, 2);
    assert.deepStrictEqual(sent[0], {
      type: 'tool_event',
      toolSessionId: 'ses_fixture_delta',
      event: deltaEvent,
    });
    assert.deepStrictEqual(sent[1], {
      type: 'tool_event',
      toolSessionId: 'ses_32c9fea15ffe2Rnv8tITmfmGmQ',
      event: updatedEvent,
    });
  });

  test('forwards empty message.part.delta as tool_event without dropping the event', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    runtime.eventFilter = new EventFilter(['message.part.delta']);
    runtime.stateManager.setState('READY');

    const emptyDeltaEvent = {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_fixture_delta_empty',
        messageID: 'msg_fixture_delta_empty',
        partID: 'prt_fixture_delta_empty',
        delta: '',
      },
    };

    await runtime.handleEvent(emptyDeltaEvent);

    assert.deepStrictEqual(sent, [
      {
        type: 'tool_event',
        toolSessionId: 'ses_fixture_delta_empty',
        event: emptyDeltaEvent,
      },
    ]);
  });

  test('preserves seeded text updated plus delta plus final text update order for the same part', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient(),
    });
    const sent = [];

    runtime.gatewayConnection = {
      send: (message) => sent.push(message),
    };
    runtime.eventFilter = new EventFilter(['message.part.updated', 'message.part.delta']);
    runtime.stateManager.setState('READY');

    const seededUpdatedEvent = {
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_seeded_text',
        delta: '',
        part: {
          sessionID: 'ses_seeded_text',
          messageID: 'msg_seeded_text',
          id: 'prt_seeded_text',
          type: 'text',
          text: '',
        },
      },
    };
    const placeholderDeltaEvent = {
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_seeded_text',
        messageID: 'msg_seeded_text',
        partID: 'prt_seeded_text',
        delta: '',
      },
    };
    const finalUpdatedEvent = {
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_seeded_text',
        part: {
          sessionID: 'ses_seeded_text',
          messageID: 'msg_seeded_text',
          id: 'prt_seeded_text',
          type: 'text',
          text: 'hello final',
        },
      },
    };

    await runtime.handleEvent(seededUpdatedEvent);
    await runtime.handleEvent(placeholderDeltaEvent);
    await runtime.handleEvent(finalUpdatedEvent);

    assert.deepStrictEqual(sent, [
      {
        type: 'tool_event',
        toolSessionId: 'ses_seeded_text',
        event: seededUpdatedEvent,
      },
      {
        type: 'tool_event',
        toolSessionId: 'ses_seeded_text',
        event: placeholderDeltaEvent,
      },
      {
        type: 'tool_event',
        toolSessionId: 'ses_seeded_text',
        event: finalUpdatedEvent,
      },
    ]);
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
    runtime.stateManager.setState('READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-chat-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-chat-1', text: 'hello' },
    });

    await runtime.handleEvent({
      type: 'session.idle',
      properties: {
        sessionID: 'tool-chat-1',
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
            sessionID: 'tool-chat-1',
          },
        },
      },
    ]);
  });
});
