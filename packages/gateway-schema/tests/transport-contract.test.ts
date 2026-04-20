import test from 'node:test';
import assert from 'node:assert/strict';

import { createGatewayWireMessageUpdatedEvent } from '../../test-support/fixtures/index.mjs';
import { assertWireViolationShape } from '../../test-support/assertions/index.mjs';
import {
  gatewayTransportControlMessageSchema,
  gatewayUplinkBusinessMessageSchema,
  gatewayWireProtocolSchema,
  validateGatewayUplinkBusinessMessage,
  validateGatewayWireProtocolMessage,
} from '../src/index.ts';

test('validateGatewayWireProtocolMessage accepts the transport envelope set', () => {
  const cases = [
    {
      type: 'register',
      deviceName: 'device-a',
      macAddress: '00:11:22:33:44:55',
      os: 'linux',
      toolType: 'opencode',
      toolVersion: '1.0.0',
    },
    {
      type: 'register',
      deviceName: 'device-no-mac',
      os: 'linux',
      toolType: 'opencode',
      toolVersion: '1.0.0',
    },
    {
      type: 'heartbeat',
      timestamp: '2026-03-30T00:00:00.000Z',
    },
    {
      type: 'register_ok',
    },
    {
      type: 'register_rejected',
      reason: 'unsupported_tool_type',
    },
    {
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: createGatewayWireMessageUpdatedEvent(),
    },
    {
      type: 'tool_done',
      toolSessionId: 'tool-1',
      welinkSessionId: 'wl-1',
      usage: { tokens: 12 },
    },
    {
      type: 'tool_error',
      welinkSessionId: 'wl-1',
      toolSessionId: 'tool-1',
      error: 'session not found',
      reason: 'session_not_found',
    },
    {
      type: 'session_created',
      welinkSessionId: 'wl-1',
      toolSessionId: 'tool-1',
      session: {
        sessionId: 'session-1',
      },
    },
    {
      type: 'status_response',
      opencodeOnline: true,
    },
  ];

  for (const message of cases) {
    const result = validateGatewayWireProtocolMessage(message);
    assert.equal(result.ok, true, message.type);
    assert.deepEqual(result.value, message);
  }
});

test('validateGatewayUplinkBusinessMessage only accepts uplink business messages', () => {
  const businessMessages = [
    {
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: createGatewayWireMessageUpdatedEvent(),
    },
    {
      type: 'tool_done',
      toolSessionId: 'tool-1',
    },
    {
      type: 'tool_error',
      error: 'failed',
    },
    {
      type: 'session_created',
      welinkSessionId: 'wl-1',
    },
    {
      type: 'status_response',
      opencodeOnline: true,
    },
  ];

  for (const message of businessMessages) {
    const result = validateGatewayUplinkBusinessMessage(message);
    assert.equal(result.ok, true, message.type);
    assert.equal(gatewayUplinkBusinessMessageSchema.safeParse(message).success, true, message.type);
    assert.equal(gatewayTransportControlMessageSchema.safeParse(message).success, false, message.type);
    assert.equal(gatewayWireProtocolSchema.safeParse(message).success, true, message.type);
  }

  const control = {
    type: 'heartbeat',
    timestamp: '2026-03-30T00:00:00.000Z',
  };

  const controlResult = validateGatewayUplinkBusinessMessage(control);
  assert.equal(controlResult.ok, false);
});

test('validateGatewayWireProtocolMessage accepts control messages through the umbrella protocol union', () => {
  const controlMessages = [
    {
      type: 'register',
      deviceName: 'device-a',
      os: 'linux',
      toolType: 'opencode',
      toolVersion: '1.0.0',
    },
    {
      type: 'register_ok',
    },
    {
      type: 'register_rejected',
      reason: 'unsupported',
    },
    {
      type: 'heartbeat',
      timestamp: '2026-03-30T00:00:00.000Z',
    },
  ];

  for (const message of controlMessages) {
    const result = validateGatewayWireProtocolMessage(message);
    assert.equal(result.ok, true, message.type);
    assert.equal(gatewayTransportControlMessageSchema.safeParse(message).success, true, message.type);
    assert.equal(gatewayUplinkBusinessMessageSchema.safeParse(message).success, false, message.type);
    assert.equal(gatewayWireProtocolSchema.safeParse(message).success, true, message.type);
  }
});

test('validateGatewayWireProtocolMessage omits blank register macAddress', () => {
  const result = validateGatewayWireProtocolMessage({
    type: 'register',
    deviceName: 'device-blank-mac',
    macAddress: '   ',
    os: 'linux',
    toolType: 'opencode',
    toolVersion: '1.0.0',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'register',
    deviceName: 'device-blank-mac',
    os: 'linux',
    toolType: 'opencode',
    toolVersion: '1.0.0',
  });
});

test('validateGatewayWireProtocolMessage rejects non-string register macAddress values', () => {
  const result = validateGatewayWireProtocolMessage({
    type: 'register',
    deviceName: 'device-invalid-mac',
    macAddress: 123,
    os: 'linux',
    toolType: 'opencode',
    toolVersion: '1.0.0',
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'transport',
    code: 'invalid_field_type',
    field: 'macAddress',
    messageType: 'register',
  });
});

test('validateGatewayWireProtocolMessage rejects unsupported transport message types', () => {
  const result = validateGatewayWireProtocolMessage({
    type: 'unknown',
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'transport',
    code: 'unsupported_message',
    field: 'type',
    messageType: 'unknown',
  });
});

test('validateGatewayWireProtocolMessage rejects malformed tool_event envelopes through the shared error envelope', () => {
  const result = validateGatewayWireProtocolMessage({
    type: 'tool_event',
    toolSessionId: 'tool-invalid',
    event: {
      type: 'session.status',
      properties: {},
    },
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'event',
    code: 'missing_required_field',
    field: 'properties.sessionID',
    messageType: 'session.status',
    eventType: 'session.status',
  });
});
