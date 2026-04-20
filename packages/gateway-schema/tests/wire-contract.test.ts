import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGatewayWireMessageUpdatedEvent,
} from '../../test-support/fixtures/index.mjs';
import {
  assertProjectedMessageUpdatedShape,
  assertWireViolationShape,
} from '../../test-support/assertions/index.mjs';
import { RecordingProtocolFailureReporter } from '../src/adapters/reporters/recording-protocol-failure-reporter.ts';
import { normalizeDownstream, validateToolEvent, validateGatewayWireProtocolMessage } from '../src/index.ts';

test('normalizeDownstream canonicalizes supported invoke shapes', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    welinkSessionId: ' wl-1 ',
    action: 'create_session',
    payload: {
      title: '  hello  ',
      assistantId: ' persona-1 ',
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepStrictEqual(result.value, {
    type: 'invoke',
    welinkSessionId: 'wl-1',
    action: 'create_session',
    payload: {
      title: 'hello',
      assistantId: 'persona-1',
    },
  });
});

test('normalizeDownstream reports contract violations through the reporter', () => {
  const reporter = new RecordingProtocolFailureReporter();
  const result = normalizeDownstream(
    {
      type: 'invoke',
      action: 'create_session',
      payload: {},
    },
    {
      reporter,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(reporter.violations.length, 1);
  assert.equal(reporter.violations[0].field, 'welinkSessionId');
});

test('validateToolEvent projects message.updated to the wire contract', () => {
  const result = validateToolEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-1',
        sessionID: 'ses-1',
        role: 'user',
        time: {
          created: 123,
          updated: 456,
        },
        agent: 'should-be-removed',
        model: {
          providerID: 'p-1',
          modelID: 'm-1',
        },
        summary: {
          additions: 2,
          deletions: 1,
          files: 1,
          diffs: [
            {
              file: 'a.ts',
              status: 'modified',
              additions: 2,
              deletions: 1,
              before: 'drop-me',
              after: 'drop-me-too',
            },
          ],
        },
      },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  const info = result.value.properties.info;
  assert.equal(info.id, 'msg-1');
  assert.equal(info.sessionID, 'ses-1');
  assert.equal(info.role, 'user');
  assert.equal(info.time.created, 123);
  assert.equal('agent' in info, false);
  assert.deepStrictEqual(info.summary, {
    additions: 2,
    deletions: 1,
    files: 1,
    diffs: [
      {
        file: 'a.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
      },
    ],
  });
});

test('validateGatewayWireProtocolMessage validates transport envelopes and nested tool events', () => {
  const result = validateGatewayWireProtocolMessage({
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      type: 'session.status',
      properties: {
        sessionID: 'ses-1',
        status: {
          type: 'busy',
        },
      },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.type, 'tool_event');
  assert.equal(result.value.event.type, 'session.status');
  assert.equal(result.value.event.properties.status.type, 'busy');
});

test('validateToolEvent returns a typed violation for unsupported event types', () => {
  const result = validateToolEvent({
    type: 'unknown.event',
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.error.violation.code, 'unsupported_event_type');
});

test('validateGatewayWireProtocolMessage rejects invalid transport payloads', () => {
  const result = validateGatewayWireProtocolMessage({
    type: 'status_response',
    opencodeOnline: 'yes',
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.error.violation.field, 'opencodeOnline');
});
