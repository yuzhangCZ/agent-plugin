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
import {
  gatewayWireProtocolSchema,
  normalizeDownstream,
  validateToolEvent,
  validateGatewayWireProtocolMessage,
} from '../src/index.ts';

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
    family: 'opencode',
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
      family: 'opencode',
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

test('gatewayWireProtocolSchema accepts downstream business requests', () => {
  const cases = [
    {
      type: 'status_query',
    },
    {
      type: 'invoke',
      action: 'create_session',
      welinkSessionId: 'wl-1',
      payload: {
        title: 'hello',
      },
    },
  ];

  for (const message of cases) {
    const result = gatewayWireProtocolSchema.safeParse(message);
    assert.equal(result.success, true, message.type);
  }
});

test('gatewayWireProtocolSchema accepts downstream, uplink business, and control frames', () => {
  const cases = [
    {
      type: 'status_query',
    },
    {
      type: 'invoke',
      action: 'create_session',
      welinkSessionId: 'wl-1',
      payload: {
        title: 'hello',
      },
    },
    {
      type: 'status_response',
      opencodeOnline: true,
    },
    {
      type: 'heartbeat',
      timestamp: '2026-03-30T00:00:00.000Z',
    },
  ];

  for (const message of cases) {
    assert.equal(gatewayWireProtocolSchema.safeParse(message).success, true, message.type);
  }
});

test('validateGatewayWireProtocolMessage accepts current-state downstream + uplink/control messages', () => {
  const cases = [
    {
      type: 'status_query',
    },
    {
      type: 'invoke',
      action: 'create_session',
      welinkSessionId: 'wl-1',
      payload: {
        title: 'hello',
      },
    },
    {
      type: 'register',
      deviceName: 'device-a',
      os: 'linux',
      toolType: 'opencode',
      toolVersion: '1.0.0',
    },
    {
      type: 'tool_done',
      toolSessionId: 'tool-1',
    },
  ];

  for (const message of cases) {
    const result = validateGatewayWireProtocolMessage(message);
    assert.equal(result.ok, true, message.type);
  }
});

test('validateGatewayWireProtocolMessage reports invalid downstream payloads once with the downstream violation', () => {
  const reporter = new RecordingProtocolFailureReporter();
  const result = validateGatewayWireProtocolMessage(
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
  if (result.ok) {
    return;
  }

  assert.equal(result.error.violation.field, 'welinkSessionId');
  assert.equal(result.error.violation.stage, 'payload');
  assert.equal(reporter.violations.length, 1);
  assert.deepStrictEqual(reporter.violations[0], result.error.violation);
});

test('validateToolEvent returns a typed violation for unsupported event types', () => {
  const result = validateToolEvent({
    family: 'opencode',
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
