import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_EVENT_TYPES } from '../../src/gateway-wire/tool-event.ts';
import { TOOL_ERROR_REASON, TRANSPORT_UPSTREAM_MESSAGE_TYPES } from '../../src/gateway-wire/transport.ts';

test('gateway-wire facade exposes the current transport contract constants', () => {
  assert.deepEqual(TOOL_EVENT_TYPES, [
    'message.updated',
    'message.part.updated',
    'message.part.delta',
    'message.part.removed',
    'session.status',
    'session.idle',
    'session.updated',
    'session.error',
    'permission.updated',
    'permission.asked',
    'question.asked',
  ]);

  assert.deepEqual(TRANSPORT_UPSTREAM_MESSAGE_TYPES, [
    'register',
    'register_ok',
    'register_rejected',
    'heartbeat',
    'tool_event',
    'tool_done',
    'tool_error',
    'session_created',
    'status_response',
  ]);

  assert.equal(TOOL_ERROR_REASON.SESSION_NOT_FOUND, 'session_not_found');
});
