import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GATEWAY_WIRE_SIMPLE_TOOL_EVENT_FIXTURES,
  createAbortSessionInvokeMessage,
  createChatInvokeMessage,
  createCompatInvalidInvokeStatusQueryMessage,
  createCreateSessionInvokeMessage,
  createCloseSessionInvokeMessage,
  createGatewayWireCreateSessionInvokeMessage,
  createGatewayWireLegacyCreateSessionInvokeMessage,
  createGatewayWirePermissionAskedEvent,
  createGatewayWirePermissionRepliedEvent,
  createGatewayWireMessagePartUpdatedToolEvent,
  createGatewayWirePermissionUpdatedEvent,
  createGatewayWireSessionStatusEvent,
  createGatewayWireMessageUpdatedEvent,
  createGatewayWireQuestionAskedEvent,
  createPermissionReplyInvokeMessage,
  createQuestionReplyInvokeMessage,
  createStatusQueryMessage,
} from '../fixtures/index.mjs';
import {
  assertMessagePartUpdatedShape,
  assertNormalizedDownstreamInvokeShape,
  assertSimpleToolEventShape,
  assertProjectedMessageUpdatedShape,
  assertNoSuccessMessageOnInvalidInput,
  assertSessionCreatedShape,
  assertStatusResponseShape,
  assertToolDoneShape,
  assertToolErrorShape,
  assertToolEventShape,
  assertWireViolationShape,
} from '../assertions/index.mjs';

test('shared fixtures and assertions expose the baseline protocol helpers', async () => {
  assert.deepStrictEqual(createStatusQueryMessage(), { type: 'status_query' });
  assert.strictEqual(createChatInvokeMessage().action, 'chat');
  assert.strictEqual(createCreateSessionInvokeMessage().action, 'create_session');
  assert.strictEqual(createCloseSessionInvokeMessage().action, 'close_session');
  assert.strictEqual(createAbortSessionInvokeMessage().action, 'abort_session');
  assert.strictEqual(createPermissionReplyInvokeMessage().action, 'permission_reply');
  assert.strictEqual(createQuestionReplyInvokeMessage().action, 'question_reply');
  assert.strictEqual(createCompatInvalidInvokeStatusQueryMessage().action, 'status_query');
  assert.strictEqual(createGatewayWireCreateSessionInvokeMessage().payload.title, 'gateway-wire session');
  assert.strictEqual(createGatewayWireLegacyCreateSessionInvokeMessage().payload.sessionId, 'legacy-session-id');
  assert.strictEqual(createGatewayWireCreateSessionInvokeMessage().payload.assistantId, 'persona-gateway');
  assert.strictEqual(createGatewayWirePermissionUpdatedEvent().properties.id, 'perm-gateway-wire');
  assert.strictEqual(createGatewayWirePermissionAskedEvent().properties.id, 'perm-gateway-wire');
  assert.strictEqual(createGatewayWirePermissionRepliedEvent().properties.requestID, 'perm-gateway-wire');
  assert.strictEqual(createGatewayWireQuestionAskedEvent().properties.tool.callID, 'call-gateway-wire');
  assert.deepStrictEqual(
    GATEWAY_WIRE_SIMPLE_TOOL_EVENT_FIXTURES.map((fixture) => fixture.type),
    [
      'message.part.delta',
      'message.part.removed',
      'session.status',
      'session.idle',
      'session.updated',
      'session.error',
      'permission.updated',
      'permission.asked',
      'permission.replied',
      'question.asked',
    ],
  );

  assert.doesNotThrow(() =>
    assertNormalizedDownstreamInvokeShape(
      createGatewayWireCreateSessionInvokeMessage(),
      {
        action: 'create_session',
        welinkSessionId: 'wl-gateway-create',
        payload: {
          title: 'gateway-wire session',
          assistantId: 'persona-gateway',
        },
        hasLegacySessionFields: false,
      },
    ),
  );
  assert.doesNotThrow(() =>
    assertNormalizedDownstreamInvokeShape(
      createPermissionReplyInvokeMessage(),
      {
        action: 'permission_reply',
        welinkSessionId: 'wl-permission',
        payload: {
          toolSessionId: 'tool-permission',
          permissionId: 'perm-1',
          response: 'once',
        },
      },
    ),
  );
  assert.doesNotThrow(() =>
    assertNormalizedDownstreamInvokeShape(
      createQuestionReplyInvokeMessage(),
      {
        action: 'question_reply',
        welinkSessionId: 'wl-question',
        payload: {
          toolSessionId: 'tool-question',
          answer: 'ok',
        },
      },
    ),
  );
  assert.doesNotThrow(() => assertToolDoneShape({ type: 'tool_done', welinkSessionId: 'wl', toolSessionId: 'tool' }, { welinkSessionId: 'wl', toolSessionId: 'tool' }));
  assert.doesNotThrow(() => assertSessionCreatedShape({ type: 'session_created', welinkSessionId: 'wl', toolSessionId: 'tool' }, { welinkSessionId: 'wl', toolSessionId: 'tool' }));
  assert.doesNotThrow(() => assertStatusResponseShape({ type: 'status_response', opencodeOnline: true }, { opencodeOnline: true, envelopeFree: true }));
  assert.doesNotThrow(() => assertToolErrorShape({ type: 'tool_error', error: 'bad', welinkSessionId: 'wl' }, { welinkSessionId: 'wl', error: 'bad', hasCode: false }));
  assert.doesNotThrow(() => assertToolEventShape({ type: 'tool_event', toolSessionId: 'tool', event: { family: 'opencode', type: 'message.updated' } }, { toolSessionId: 'tool', eventType: 'message.updated' }));
  assert.doesNotThrow(() =>
    assertSimpleToolEventShape(createGatewayWireSessionStatusEvent(), {
      type: 'session.status',
      properties: {
        sessionID: 'tool-gateway-wire',
        status: { type: 'busy' },
      },
    }),
  );
  assert.doesNotThrow(() =>
    assertSimpleToolEventShape(createGatewayWirePermissionUpdatedEvent(), {
      type: 'permission.updated',
      properties: {
        sessionID: 'tool-gateway-wire',
        id: 'perm-gateway-wire',
        status: 'granted',
      },
    }),
  );
  assert.doesNotThrow(() => assertNoSuccessMessageOnInvalidInput([{ type: 'tool_error', error: 'bad' }]));
  assert.doesNotThrow(() => assertProjectedMessageUpdatedShape(createGatewayWireMessageUpdatedEvent(), { hasSummary: true, diffCount: 1 }));
  assert.doesNotThrow(() =>
    assertMessagePartUpdatedShape(createGatewayWireMessagePartUpdatedToolEvent(), {
      part: {
        id: 'part-gateway-wire-tool',
        sessionID: 'tool-gateway-wire',
        messageID: 'msg-gateway-wire-tool',
        type: 'tool',
        tool: 'search',
        callID: 'call-gateway-wire-tool',
        state: {
          status: 'completed',
          output: {
            total: 3,
            nested: {
              ok: true,
            },
          },
          error: 'tool failed',
          title: 'Search results',
        },
      },
    }),
  );
  assert.doesNotThrow(() =>
    assertWireViolationShape(
      {
        stage: 'payload',
        code: 'missing_required_field',
        field: 'welinkSessionId',
        message: 'welinkSessionId is required',
        messageType: 'invoke',
        action: 'create_session',
      },
      {
        stage: 'payload',
        code: 'missing_required_field',
        field: 'welinkSessionId',
        message: 'welinkSessionId is required',
        messageType: 'invoke',
        action: 'create_session',
      },
      ),
  );
});
