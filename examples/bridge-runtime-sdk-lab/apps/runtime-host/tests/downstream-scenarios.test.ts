import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGatewayDownstreamViews } from '../src/downstream-view.ts';
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

test('gateway downstream views include mock raw and sdk processed summaries', () => {
  const views = buildGatewayDownstreamViews([
    {
      id: 1,
      at: 1000,
      type: 'mock_gateway.downstream',
      message: 'Mock gateway sent downstream',
      meta: {
        raw: {
          type: 'invoke',
          action: 'chat',
          welinkSessionId: 'wl-1',
          payload: { toolSessionId: 'tool-1' },
        },
      },
    },
    {
      id: 2,
      at: 1001,
      type: 'sdk.log.info',
      message: '「onMessage」===>「{"type":"invoke","action":"chat","welinkSessionId":"wl-raw","payload":{"toolSessionId":"tool-raw","text":"hello raw"}}」',
    },
    {
      id: 3,
      at: 1002,
      type: 'sdk.log.debug',
      message: 'gateway.message.received',
      meta: {
        messageType: 'invoke',
        action: 'chat',
        toolSessionId: 'tool-1',
        welinkSessionId: 'wl-1',
      },
    },
    {
      id: 4,
      at: 1003,
      type: 'sdk.log.info',
      message: 'runtime_sdk.downstream.received',
      meta: {
        messageType: 'invoke',
        action: 'chat',
        toolSessionId: 'tool-1',
        welinkSessionId: 'wl-1',
      },
    },
    {
      id: 5,
      at: 1004,
      type: 'sdk.log.warn',
      message: 'runtime_sdk.downstream.invalid_invoke_rejected',
      meta: {
        messageType: 'invoke',
        toolSessionId: 'tool-1',
        welinkSessionId: 'wl-1',
        error: 'invalid',
        code: 'invalid_field_value',
      },
    },
  ], 'mock-gateway');

  assert.equal(views.length, 5);
  assert.equal(views[0]?.phase, 'invalid_invoke_rejected');
  assert.equal(views[1]?.phase, 'received');
  assert.equal(views[2]?.phase, 'received');
  assert.equal(views[3]?.phase, 'received');
  assert.equal(views[3]?.rawText?.includes('"text":"hello raw"'), true);
  assert.equal(views[4]?.phase, 'mock_sent');
  assert.equal(views[4]?.raw && typeof views[4].raw, 'object');
  assert.equal(views[4]?.rawText?.includes('"action":"chat"'), true);
});
