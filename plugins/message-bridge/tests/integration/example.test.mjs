import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createChatInvokeMessage,
  createCompatInvalidInvokeStatusQueryMessage,
  createCreateSessionInvokeMessage,
  createStatusQueryMessage,
} from '@agent-plugin/test-support/fixtures';
import {
  assertNoSuccessMessageOnInvalidInput,
  assertSessionCreatedShape,
  assertStatusResponseShape,
  assertToolDoneShape,
  assertToolErrorShape,
} from '@agent-plugin/test-support/assertions';
import { createMessageRecorder } from '@agent-plugin/test-support/transport';

import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts';

function createRuntimeClient() {
  return {
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
}

function createRuntimeHarness({ state = 'READY', routeResult } = {}) {
  const runtime = new BridgeRuntime({ client: createRuntimeClient() });
  const recorder = createMessageRecorder();

  runtime.gatewayConnection = {
    send: recorder.send,
  };
  runtime.stateManager.setState(state);
  runtime.actionRouter = {
    route: async () => routeResult ?? { success: true, data: { ok: true } },
  };

  return { runtime, sent: recorder.messages };
}

describe('downlink -> uplink protocol', () => {
  test('invoke/chat success -> emits tool_done compat message', async () => {
    const { runtime, sent } = createRuntimeHarness({
      routeResult: { success: true, data: { text: 'ok' } },
    });

    await runtime.handleDownstreamMessage(
      createChatInvokeMessage({ welinkSessionId: 's-1', payload: { toolSessionId: 'tool-1', text: 'hi' } }),
    );

    assert.strictEqual(sent.length, 1);
    assertToolDoneShape(sent[0], {
      toolSessionId: 'tool-1',
      welinkSessionId: 's-1',
    });
  });

  test('invoke/create_session -> session_created', async () => {
    const { runtime, sent } = createRuntimeHarness({
      routeResult: { success: true, data: { sessionId: 'created-1' } },
    });

    await runtime.handleDownstreamMessage(
      createCreateSessionInvokeMessage({ welinkSessionId: 'skill-1' }),
    );

    assert.strictEqual(sent.length, 1);
    assertSessionCreatedShape(sent[0], {
      welinkSessionId: 'skill-1',
      toolSessionId: 'created-1',
    });
  });

  test('invalid payload failure -> tool_error without code field', async () => {
    const { runtime, sent } = createRuntimeHarness({
      routeResult: { success: false, errorCode: 'INVALID_PAYLOAD', errorMessage: 'bad payload' },
    });

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 's-err',
      action: 'chat',
      payload: { bad: true },
    });

    assert.strictEqual(sent.length, 1);
    assertToolErrorShape(sent[0], {
      welinkSessionId: 's-err',
      error: 'Invalid invoke payload shape',
      hasCode: false,
    });
    assertNoSuccessMessageOnInvalidInput(sent);
  });

  test('status_query -> status_response', async () => {
    const { runtime, sent } = createRuntimeHarness({
      routeResult: { success: true, data: { opencodeOnline: true } },
    });

    await runtime.handleDownstreamMessage(createStatusQueryMessage());

    assert.strictEqual(sent.length, 1);
    assertStatusResponseShape(sent[0], {
      opencodeOnline: true,
      envelopeFree: true,
    });
  });

  test('invoke/status_query variant -> tool_error', async () => {
    const { runtime, sent } = createRuntimeHarness();

    await runtime.handleDownstreamMessage(
      createCompatInvalidInvokeStatusQueryMessage({ welinkSessionId: 's-3' }),
    );

    assert.strictEqual(sent.length, 1);
    assertToolErrorShape(sent[0], {
      welinkSessionId: 's-3',
      hasCode: false,
    });
    assertNoSuccessMessageOnInvalidInput(sent);
  });
});
