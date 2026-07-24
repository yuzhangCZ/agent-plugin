import type { DownstreamRunResult, DownstreamScenario, ToolErrorView } from '@agent-plugin/bridge-runtime-sdk-lab-shared';

import { EventStore } from './event-store.ts';
import { LabMockGateway } from './mock-gateway.ts';
import { TestProvider } from './test-provider.ts';

export class DownstreamScenarioRunner {
  readonly #gateway: LabMockGateway;
  readonly #provider: TestProvider;
  readonly #events: EventStore;
  readonly #getFailures: () => unknown[];

  constructor(input: {
    gateway: LabMockGateway;
    provider: TestProvider;
    events: EventStore;
    getFailures: () => unknown[];
  }) {
    this.#gateway = input.gateway;
    this.#provider = input.provider;
    this.#events = input.events;
    this.#getFailures = input.getFailures;
  }

  async run(scenario: DownstreamScenario, raw = scenario.raw): Promise<DownstreamRunResult> {
    if (scenario.expected.providerScenario) {
      this.#provider.setScenario(scenario.expected.providerScenario);
    }

    const fromIndex = this.#gateway.receivedMessages.length;
    const failuresFromIndex = this.#getFailures().length;
    if (scenario.trigger === 'provider_outbound') {
      await this.#provider.emitOutboundRun(scenario.expected.providerScenario?.kind);
    } else if (scenario.trigger === 'mock_gateway_disconnect') {
      this.#gateway.disconnectActive();
    } else {
      this.#gateway.send(raw);
    }
    const uplinks = await this.#gateway.waitForMessages(fromIndex);
    const failures = this.#getFailures().slice(failuresFromIndex);
    const toolErrors = uplinks
      .filter(isToolError)
      .map((message) => toToolErrorView(message, scenario.expected.stage));
    const matchedExpectation = matchesExpectation(scenario, uplinks, toolErrors, failures);
    const result: DownstreamRunResult = {
      scenario,
      raw,
      uplinks,
      toolErrors,
      failures,
      matchedExpectation,
      note: buildNote(scenario, toolErrors, uplinks),
    };
    this.#events.append('downstream.scenario.completed', `Downstream scenario completed: ${scenario.id}`, {
      scenarioId: scenario.id,
      matchedExpectation,
      toolErrorCount: toolErrors.length,
    });
    return result;
  }
}

function matchesExpectation(
  scenario: DownstreamScenario,
  uplinks: unknown[],
  toolErrors: ToolErrorView[],
  failures: unknown[],
): boolean {
  if (scenario.expected.outcome === 'failure_only') {
    return toolErrors.length === 0;
  }
  if (scenario.expected.outcome === 'diagnostics_only') {
    return toolErrors.length === 0;
  }
  if (scenario.expected.outcome === 'runtime_failed') {
    return failures.length > 0 && toolErrors.length === 0;
  }
  if (scenario.expected.outcome === 'tool_error') {
    return toolErrors.some((toolError) => {
      const errorMatches = scenario.expected.errorIncludes ? toolError.error.includes(scenario.expected.errorIncludes) : true;
      const reasonMatches = scenario.expected.reason ? toolError.reason === scenario.expected.reason : true;
      return errorMatches && reasonMatches;
    });
  }
  return uplinks.some((message) => {
    return isRecord(message) && message.type === scenario.expected.outcome;
  });
}

function buildNote(scenario: DownstreamScenario, toolErrors: ToolErrorView[], uplinks: unknown[]): string {
  if (scenario.expected.outcome === 'tool_error' && toolErrors.length === 0) {
    return '未捕获到 tool_error：请确认 mock gateway 已连接且下行消息具备可回包路由目标。';
  }
  if (scenario.expected.outcome === 'failure_only' && toolErrors.length === 0) {
    return '无 tool_error，符合预期：该场景只记录 failure，不具备可回包路由目标。';
  }
  if (scenario.expected.outcome === 'diagnostics_only' && toolErrors.length === 0) {
    return '无 tool_error，符合预期：该场景按方案只记录 diagnostics 或继续产生正常终态。';
  }
  if (scenario.expected.outcome === 'runtime_failed' && toolErrors.length === 0) {
    return '无 tool_error，符合预期：gateway 不可用时通过 runtime status/diagnostics 感知。';
  }
  if (uplinks.length === 0) {
    return '未捕获到上行消息。';
  }
  return '已捕获上行消息。';
}

function toToolErrorView(message: Record<string, unknown>, stage: ToolErrorView['stage']): ToolErrorView {
  return {
    error: typeof message.error === 'string' ? message.error : String(message.error),
    toolSessionId: typeof message.toolSessionId === 'string' ? message.toolSessionId : undefined,
    welinkSessionId: typeof message.welinkSessionId === 'string' ? message.welinkSessionId : undefined,
    reason: typeof message.reason === 'string' ? message.reason : undefined,
    stage,
  };
}

function isToolError(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === 'tool_error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
