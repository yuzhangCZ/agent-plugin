import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGatewayWireLegacyCreateSessionInvokeMessage,
} from '../../test-support/fixtures/index.mjs';
import { assertWireViolationShape } from '../../test-support/assertions/index.mjs';
import { normalizeDownstream, validateToolEvent } from '../src/index.ts';

test('downstream contract violations use the shared violation envelope', () => {
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

test('tool_event contract violations use the shared violation envelope', () => {
  const result = validateToolEvent({
    family: 'opencode',
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-1',
        sessionID: 'tool-session-1',
      },
    },
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'event',
    code: 'missing_required_field',
    field: 'properties.part.messageID',
    messageType: 'message.part.updated',
  });
});

test('the canonical shared normalizer does not depend on legacy create_session payload fields', () => {
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
