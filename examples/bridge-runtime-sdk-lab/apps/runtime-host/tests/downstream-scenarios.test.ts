import assert from 'node:assert/strict';
import test from 'node:test';

import { getDownstreamScenarios } from '../src/downstream-scenarios.ts';

test('downstream scenarios include explicit tool_error coverage', () => {
  const scenarios = getDownstreamScenarios();
  const toolErrorScenarios = scenarios.filter((scenario) => scenario.expected.outcome === 'tool_error');

  assert.ok(toolErrorScenarios.length >= 6);
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'invalid-chat-missing-text'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'question-reply-pending-missing'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'create-session-provider-throws'));
  assert.ok(toolErrorScenarios.every((scenario) => scenario.expected.stage));
});

test('downstream scenarios mark no-route invalid invoke as failure only', () => {
  const scenario = getDownstreamScenarios().find((item) => item.id === 'invalid-invoke-no-route-target');

  assert.equal(scenario?.expected.outcome, 'failure_only');
  assert.equal(scenario?.expected.stage, 'inbound_validation');
});
