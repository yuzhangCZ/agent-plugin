import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAbortSessionInvokeMessage,
  createChatInvokeMessage,
  createCloseSessionInvokeMessage,
  createGatewayWireCreateSessionInvokeMessage,
  createGatewayWireLegacyCreateSessionInvokeMessage,
  createPermissionReplyInvokeMessage,
  createQuestionReplyInvokeMessage,
  createStatusQueryMessage,
} from '../../test-support/fixtures/index.mjs';
import { assertWireViolationShape } from '../../test-support/assertions/index.mjs';
import { normalizeDownstream } from '../src/index.ts';

test('normalizeDownstream accepts the full downstream contract', () => {
  const cases = [
    [
      'status_query',
      createStatusQueryMessage(),
      {
        type: 'status_query',
      },
    ],
    [
      'chat',
      createChatInvokeMessage({
        welinkSessionId: 'wl-chat',
        payload: {
          toolSessionId: 'tool-chat',
          text: 'hello',
          assistantId: 'persona-a',
        },
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-chat',
        action: 'chat',
        payload: {
          toolSessionId: 'tool-chat',
          text: 'hello',
          assistantId: 'persona-a',
        },
      },
    ],
    [
      'create_session',
      createGatewayWireCreateSessionInvokeMessage({
        welinkSessionId: 'wl-create',
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-create',
        action: 'create_session',
        payload: {
          title: 'gateway-wire session',
          assistantId: 'persona-gateway',
        },
      },
    ],
    [
      'close_session',
      createCloseSessionInvokeMessage({
        welinkSessionId: 'wl-close',
        payload: { toolSessionId: 'tool-close' },
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-close',
        action: 'close_session',
        payload: {
          toolSessionId: 'tool-close',
        },
      },
    ],
    [
      'abort_session',
      createAbortSessionInvokeMessage({
        welinkSessionId: 'wl-abort',
        payload: { toolSessionId: 'tool-abort' },
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-abort',
        action: 'abort_session',
        payload: {
          toolSessionId: 'tool-abort',
        },
      },
    ],
    [
      'permission_reply',
      createPermissionReplyInvokeMessage({
        welinkSessionId: 'wl-permission',
        payload: {
          toolSessionId: 'tool-permission',
          permissionId: 'perm-1',
          response: 'once',
        },
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-permission',
        action: 'permission_reply',
        payload: {
          toolSessionId: 'tool-permission',
          permissionId: 'perm-1',
          response: 'once',
        },
      },
    ],
    [
      'question_reply',
      createQuestionReplyInvokeMessage({
        welinkSessionId: 'wl-question',
        payload: {
          toolSessionId: 'tool-question',
          answer: 'ok',
          toolCallId: 'call-1',
        },
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-question',
        action: 'question_reply',
        payload: {
          toolSessionId: 'tool-question',
          answer: 'ok',
          toolCallId: 'call-1',
        },
      },
    ],
  ];

  for (const [name, input, expected] of cases) {
    const result = normalizeDownstream(input);
    assert.equal(result.ok, true, name);
    assert.deepEqual(result.value, expected);
  }
});

test('normalizeDownstream ignores deprecated assiantId instead of treating it as assistantId', () => {
  const cases = [
    createChatInvokeMessage({
      welinkSessionId: 'wl-chat-legacy',
      payload: {
        toolSessionId: 'tool-chat-legacy',
        text: 'hello',
        assiantId: 'persona-legacy',
      },
    }),
    createGatewayWireCreateSessionInvokeMessage({
      welinkSessionId: 'wl-create-legacy',
      payload: {
        title: 'legacy assistant field',
        assiantId: 'persona-legacy',
      },
    }),
  ];

  for (const input of cases) {
    const result = normalizeDownstream(input);
    assert.equal(result.ok, true);
    if (!result.ok || result.value.type !== 'invoke') {
      continue;
    }

    assert.equal('assistantId' in result.value.payload, false);
    assert.equal('assiantId' in result.value.payload, false);
  }
});

test('normalizeDownstream ignores legacy create_session payload fields in the shared contract', () => {
  const result = normalizeDownstream(createGatewayWireLegacyCreateSessionInvokeMessage());

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    welinkSessionId: 'wl-gateway-legacy-create',
    action: 'create_session',
    payload: {},
  });
  assert.equal('sessionId' in result.value.payload, false);
  assert.equal('metadata' in result.value.payload, false);
});

test('normalizeDownstream rejects missing create_session welinkSessionId', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'create_session',
    payload: {
      title: 'missing welink',
    },
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'missing_required_field',
    field: 'welinkSessionId',
    messageType: 'invoke',
    action: 'create_session',
  });
});

test('normalizeDownstream rejects invalid permission_reply response values', () => {
  const result = normalizeDownstream(
    createPermissionReplyInvokeMessage({
      payload: {
        toolSessionId: 'tool-permission',
        permissionId: 'perm-1',
        response: 'invalid',
      },
    }),
  );

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_value',
    field: 'payload.response',
    messageType: 'invoke',
    action: 'permission_reply',
  });
});

test('normalizeDownstream rejects non-string chat assistantId', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      welinkSessionId: 'wl-chat-invalid-assistant',
      payload: {
        toolSessionId: 'tool-chat-invalid-assistant',
        text: 'hello',
        assistantId: 123,
      },
    }),
  );

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_type',
    field: 'payload.assistantId',
    messageType: 'invoke',
    action: 'chat',
  });
});

test('normalizeDownstream accepts question_reply without welinkSessionId through the public API', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      toolSessionId: 'tool-question',
      answer: 'ok',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      toolSessionId: 'tool-question',
      answer: 'ok',
    },
  });
});
