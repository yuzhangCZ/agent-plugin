import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_EVENT_TYPES } from '../../src/gateway-wire/tool-event.ts';
import { TOOL_ERROR_REASON, TRANSPORT_UPSTREAM_MESSAGE_TYPES } from '../../src/gateway-wire/transport.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');

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

test('gateway-wire facade source does not re-export legacy alias names', async () => {
  const [transportSource, toolEventSource] = await Promise.all([
    readFile(resolve(repoRoot, 'src/gateway-wire/transport.ts'), 'utf8'),
    readFile(resolve(repoRoot, 'src/gateway-wire/tool-event.ts'), 'utf8'),
  ]);

  assert.doesNotMatch(transportSource, /GatewayUplinkBusinessMessage as UpstreamMessage/);
  assert.doesNotMatch(toolEventSource, /GatewayToolEventPayload as GatewayToolEvent/);
  assert.doesNotMatch(toolEventSource, /MessageUpdatedEvent as GatewayMessageUpdatedEvent/);
});
