import test from 'node:test';
import assert from 'node:assert/strict';

import { createGatewayWireMessageUpdatedEvent } from '../../test-support/fixtures/index.mjs';
import * as gatewaySchema from '../src/index.ts';

test('gatewayToolEventPayloadSchema only accepts the current OpencodeProviderEvent family', () => {
  const result = gatewaySchema.gatewayToolEventPayloadSchema.safeParse(createGatewayWireMessageUpdatedEvent());
  assert.equal(result.success, true);
});

test('public API does not expose SkillProviderEvent placeholders', () => {
  assert.equal('SkillProviderEvent' in gatewaySchema, false);
  assert.equal('SkillProviderEventPayload' in gatewaySchema, false);
  assert.equal('skillProviderEventSchema' in gatewaySchema, false);
});

