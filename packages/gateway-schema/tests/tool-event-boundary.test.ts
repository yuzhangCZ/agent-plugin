import test from 'node:test';
import assert from 'node:assert/strict';

import { createGatewayWireMessageUpdatedEvent } from '../../test-support/fixtures/index.mjs';
import * as gatewaySchema from '../src/index.ts';

test('gatewayToolEventPayloadSchema requires an explicit family discriminator', () => {
  assert.equal(
    gatewaySchema.gatewayToolEventPayloadSchema.safeParse(createGatewayWireMessageUpdatedEvent()).success,
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

test('public API exposes both opencode and skill tool_event payload families', () => {
  assert.equal('opencodeProviderEventSchema' in gatewaySchema, true);
  assert.equal('skillProviderEventSchema' in gatewaySchema, true);
});
