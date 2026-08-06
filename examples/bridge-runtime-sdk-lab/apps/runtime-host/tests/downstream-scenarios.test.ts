import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGatewayDownstreamViews } from '../src/downstream-view.ts';
import { DownstreamScenarioRunner } from '../src/downstream-runner.ts';
import { getDownstreamScenarios } from '../src/downstream-scenarios.ts';
import { EventStore } from '../src/event-store.ts';
import { LabMockGateway } from '../src/mock-gateway.ts';
import { RuntimeManager } from '../src/runtime-manager.ts';
import { TestProvider } from '../src/test-provider.ts';

test('downstream scenarios include explicit tool_error coverage', () => {
  const scenarios = getDownstreamScenarios();
  const toolErrorScenarios = scenarios.filter((scenario) => scenario.expected.outcome === 'tool_error');

  assert.ok(toolErrorScenarios.length >= 18);
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'invalid-chat-missing-text'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'question-reply-pending-missing'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'create-session-provider-throws'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'chat-invalid-facts'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'chat-terminal-session-not-found'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'outbound-run-invalid-facts'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'question-reply-provider-throws'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'permission-reply-provider-throws'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'close-session-provider-throws'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'abort-session-provider-throws'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'question-pending-interaction-conflict'));
  assert.ok(toolErrorScenarios.some((scenario) => scenario.id === 'permission-pending-interaction-conflict'));
  assert.ok(toolErrorScenarios.every((scenario) => scenario.expected.stage));
});

test('inbound invalid scenarios expect user-facing format error messages', () => {
  const scenarios = getDownstreamScenarios();
  const inboundInvalidToolErrors = scenarios.filter((scenario) => {
    return scenario.expected.outcome === 'tool_error' && scenario.expected.stage === 'inbound_invalid';
  });

  assert.ok(inboundInvalidToolErrors.length > 0);
  assert.equal(
    inboundInvalidToolErrors.some((scenario) => scenario.expected.errorIncludes === 'gateway_invalid_invoke'),
    false,
  );
  assert.ok(inboundInvalidToolErrors.every((scenario) => {
    return scenario.expected.errorIncludes?.startsWith('请求格式异常，请稍后重试')
      || scenario.expected.errorIncludes?.startsWith('暂不支持该操作类型');
  }));
});

test('multi-step scenarios describe ordered gateway and provider actions', () => {
  const scenarios = getDownstreamScenarios();
  const questionProviderThrow = scenarios.find((item) => item.id === 'question-reply-provider-throws');

  assert.equal(questionProviderThrow?.steps?.[0]?.kind, 'provider_scenario');
  assert.equal(questionProviderThrow?.steps?.some((step) => step.kind === 'wait_for_uplink'), true);
  assert.equal(questionProviderThrow?.steps?.at(-1)?.kind, 'gateway_downstream');
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

test('new stage matrix scenarios execute against sdk and mock gateway', async () => {
  const events = new EventStore();
  const gateway = new LabMockGateway(events);
  const provider = new TestProvider(events);
  const manager = new RuntimeManager({ events, provider });
  const runner = new DownstreamScenarioRunner({
    gateway,
    provider,
    events,
    getFailures: () => manager.getDiagnostics()?.failures ?? [],
  });

  const started = await gateway.start();
  try {
    await manager.create({
      url: started.url,
      auth: { ak: 'lab-ak', sk: 'lab-sk' },
      register: { channel: 'sdk-lab', toolVersion: 'test', pluginVersion: 'test' },
    });
    await manager.start();
    await waitFor(() => gateway.connected);

    const scenarios = getDownstreamScenarios();
    for (const id of [
      'question-reply-provider-throws',
      'permission-reply-provider-throws',
      'close-session-provider-throws',
      'abort-session-provider-throws',
      'question-pending-interaction-conflict',
      'permission-pending-interaction-conflict',
    ]) {
      const scenario = scenarios.find((item) => item.id === id);
      assert.ok(scenario, `missing scenario ${id}`);
      let result;
      try {
        result = await runner.run(scenario);
      } catch (error) {
        const recentEvents = events.list().slice(-12).map((event) => `${event.type}:${event.message}:${JSON.stringify(event.meta ?? {})}`).join(' | ');
        throw new Error(`${id}: ${error instanceof Error ? error.message : String(error)}; events=${recentEvents}`);
      }
      assert.equal(result.matchedExpectation, true, `${id}: ${result.note ?? 'expectation mismatch'}`);
    }
  } finally {
    await manager.stop();
    await gateway.stop();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}
