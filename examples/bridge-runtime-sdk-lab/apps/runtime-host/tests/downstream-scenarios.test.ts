import assert from 'node:assert/strict';
import test from 'node:test';

import { getDownstreamScenarios } from '../src/downstream-scenarios.ts';

test('downstream scenarios include explicit tool_error coverage', () => {
  const scenarios = getDownstreamScenarios();
  const toolErrorScenarios = scenarios.filter((scenario) => scenario.expected.outcome === 'tool_error');

  assert.ok(toolErrorScenarios.length >= 12);
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'invalid-chat-missing-text'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'question-reply-pending-missing'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'create-session-provider-throws'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'chat-invalid-facts'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'chat-terminal-session-not-found'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'outbound-run-invalid-facts'));
  assert.ok(toolErrorScenarios.every((scenario) => scenario.expected.stage));
});

test('downstream scenarios mark no-route invalid invoke as failure only', () => {
  const scenario = getDownstreamScenarios().find((item) => item.id === 'invalid-invoke-no-route-target');

  assert.equal(scenario?.expected.outcome, 'failure_only');
  assert.equal(scenario?.expected.stage, 'inbound_invalid');
});

test('stage matrix scenarios cover diagnostics-only and fake gateway status paths', () => {
  const scenarios = getDownstreamScenarios();

  assert.equal(
    scenarios.find((item) => item.id === 'chat-enrich-failure-continues')?.expected.outcome,
    'diagnostics_only',
  );
  assert.equal(
    scenarios.find((item) => item.id === 'outbound-run-enrich-failure-continues')?.trigger,
    'provider_outbound',
  );
  assert.equal(
    scenarios.find((item) => item.id === 'mock-gateway-disconnect')?.expected.outcome,
    'runtime_failed',
  );
});
