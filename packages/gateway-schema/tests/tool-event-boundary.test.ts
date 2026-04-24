import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGatewayWireMessageUpdatedEvent,
  createGatewayWireSessionStatusEvent,
  createGatewayWireTextDeltaEvent,
} from '../../test-support/fixtures/index.mjs';
import * as gatewaySchema from '../src/index.ts';

test('gatewayToolEventPayloadSchema accepts canonical provider discriminators', () => {
  assert.equal(
    gatewaySchema.gatewayToolEventPayloadSchema.safeParse(createGatewayWireMessageUpdatedEvent()).success,
    true,
  );
  assert.equal(
    gatewaySchema.gatewayToolEventPayloadSchema.safeParse(createGatewayWireTextDeltaEvent()).success,
    true,
  );
  assert.equal(
    gatewaySchema.gatewayToolEventPayloadSchema.safeParse({
      type: 'session.idle',
      properties: {},
    }).success,
    false,
  );
});

test('gatewayToolEventPayloadSchema dispatches by protocol without provider fallback', () => {
  const cloudSkill = gatewaySchema.gatewayToolEventPayloadSchema.safeParse(createGatewayWireTextDeltaEvent());
  assert.equal(cloudSkill.success, true);

  const cloudOpencodeLike = gatewaySchema.gatewayToolEventPayloadSchema.safeParse({
    ...createGatewayWireSessionStatusEvent(),
    protocol: 'cloud',
  });
  assert.equal(cloudOpencodeLike.success, false);

  const invalidProtocol = gatewaySchema.gatewayToolEventPayloadSchema.safeParse({
    ...createGatewayWireSessionStatusEvent(),
    protocol: 'other',
  });
  assert.equal(invalidProtocol.success, false);

  const undefinedProtocol = gatewaySchema.gatewayToolEventPayloadSchema.safeParse({
    ...createGatewayWireSessionStatusEvent(),
    protocol: undefined,
  });
  assert.equal(undefinedProtocol.success, false);
});

test('gatewayToolEventPayloadSchema preserves delegated opencode validation issues instead of collapsing them to custom root errors', () => {
  const invalidOpencodeEvent = gatewaySchema.gatewayToolEventPayloadSchema.safeParse({
    type: 'session.status',
    properties: {},
  });

  assert.equal(invalidOpencodeEvent.success, false);
  if (invalidOpencodeEvent.success) {
    return;
  }

  assert.equal(invalidOpencodeEvent.error.issues[0]?.code, 'invalid_union');
  assert.deepEqual(invalidOpencodeEvent.error.issues[0]?.path, ['value']);
  assert.notEqual(invalidOpencodeEvent.error.issues[0]?.code, 'custom');
});

test('tool_event keeps toolSessionId on the envelope and strips nested payload copies', () => {
  const result = gatewaySchema.toolEventMessageSchema.safeParse({
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      ...createGatewayWireMessageUpdatedEvent(),
      toolSessionId: 'tool-should-not-live-in-payload',
    },
  });

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }

  assert.equal(result.data.toolSessionId, 'tool-1');
  assert.equal('toolSessionId' in result.data.event, false);
});

test('tool_event preserves optional subagent envelope fields', () => {
  const result = gatewaySchema.toolEventMessageSchema.safeParse({
    type: 'tool_event',
    toolSessionId: 'tool-parent',
    subagentSessionId: ' tool-child ',
    subagentName: ' research-agent ',
    event: createGatewayWireMessageUpdatedEvent(),
  });

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }

  assert.equal(result.data.toolSessionId, 'tool-parent');
  assert.equal(result.data.subagentSessionId, 'tool-child');
  assert.equal(result.data.subagentName, 'research-agent');
});

test('tool_event envelope shares the same explicit provider dispatch rules', () => {
  const cloudOpencodeLike = gatewaySchema.toolEventMessageSchema.safeParse({
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      ...createGatewayWireSessionStatusEvent(),
      protocol: 'cloud',
    },
  });
  assert.equal(cloudOpencodeLike.success, false);

  const opencodeMessage = gatewaySchema.toolEventMessageSchema.safeParse({
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: createGatewayWireSessionStatusEvent(),
  });
  assert.equal(opencodeMessage.success, true);
});

test('transport validator preserves optional subagent envelope fields', () => {
  const result = gatewaySchema.validateGatewayUpstreamTransportMessage({
    type: 'tool_event',
    toolSessionId: 'tool-parent',
    subagentSessionId: ' tool-child ',
    subagentName: ' research-agent ',
    event: createGatewayWireMessageUpdatedEvent(),
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.value.type, 'tool_event');
  assert.equal(result.value.toolSessionId, 'tool-parent');
  assert.equal(result.value.subagentSessionId, 'tool-child');
  assert.equal(result.value.subagentName, 'research-agent');
});

test('tool_event rejects blank subagent envelope fields', () => {
  const result = gatewaySchema.toolEventMessageSchema.safeParse({
    type: 'tool_event',
    toolSessionId: 'tool-parent',
    subagentSessionId: ' ',
    event: createGatewayWireMessageUpdatedEvent(),
  });

  assert.equal(result.success, false);
});

test('validateToolEvent reuses the same provider dispatch rules as direct safeParse', () => {
  const cloudSkill = gatewaySchema.validateToolEvent(createGatewayWireTextDeltaEvent());
  assert.equal(cloudSkill.ok, true);

  const cloudOpencodeLike = gatewaySchema.validateToolEvent({
    ...createGatewayWireSessionStatusEvent(),
    protocol: 'cloud',
  });
  assert.equal(cloudOpencodeLike.ok, false);

  const invalidProtocol = gatewaySchema.validateToolEvent({
    ...createGatewayWireSessionStatusEvent(),
    protocol: 'other',
  });
  assert.equal(invalidProtocol.ok, false);

  const undefinedProtocol = gatewaySchema.validateToolEvent({
    ...createGatewayWireSessionStatusEvent(),
    protocol: undefined,
  });
  assert.equal(undefinedProtocol.ok, false);
});

test('public API exposes both opencode and cloud tool_event payload schemas', () => {
  assert.equal('opencodeProviderEventSchema' in gatewaySchema, true);
  assert.equal('skillProviderEventSchema' in gatewaySchema, true);
});
