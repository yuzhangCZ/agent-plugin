import type {
  ProviderAbortSessionInput,
  ProviderCloseSessionInput,
  ProviderCreateSessionInput,
  ProviderCreateSessionResult,
  ProviderFact,
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderListSlashCommandsInput,
  ProviderListSlashCommandsResult,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
  ThirdPartyAgentProvider,
} from '@wecode/bridge-runtime-sdk';
import type { ProviderScenarioConfig, ProviderScenarioKind } from '@agent-plugin/bridge-runtime-sdk-lab-shared';

import { EventStore } from './event-store.ts';
import { ManualAgentController } from './manual-agent-controller.ts';

const DEFAULT_SCENARIO: ProviderScenarioConfig = {
  command: '*',
  kind: 'success',
};

export class TestProvider implements ThirdPartyAgentProvider {
  readonly #events: EventStore;
  readonly #manualAgent: ManualAgentController;
  readonly #scenarios = new Map<string, ProviderScenarioConfig>();
  #context: ProviderRuntimeContext | undefined;

  constructor(events: EventStore, manualAgent = new ManualAgentController(events)) {
    this.#events = events;
    this.#manualAgent = manualAgent;
  }

  get manualAgent(): ManualAgentController {
    return this.#manualAgent;
  }

  setScenario(config: ProviderScenarioConfig): void {
    this.#scenarios.set(config.command, config);
    this.#events.append('scenario.configured', `Provider scenario set for ${config.command}`, config as unknown as Record<string, unknown>);
  }

  async initialize(context: ProviderRuntimeContext): Promise<void> {
    this.#context = context;
    this.#events.append('provider.initialize', 'Provider runtime context initialized');
    await this.#maybeDelay('initialize');
    this.#throwIfNeeded('initialize');
  }

  async health(input: ProviderHealthInput): Promise<ProviderHealthResult> {
    const scenario = await this.#beforeCall('health', input);
    return {
      online: scenario.kind !== 'offline',
    };
  }

  async createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult> {
    await this.#beforeCall('createSession', input);
    return {
      toolSessionId: `ses_${crypto.randomUUID()}`,
      title: input.title ?? 'SDK Lab Session',
    };
  }

  async listSlashCommands(input: ProviderListSlashCommandsInput): Promise<ProviderListSlashCommandsResult> {
    await this.#beforeCall('listSlashCommands', input);
    return {
      slashCommands: [
        { command: '/new', description: 'Create a new lab session' },
        { command: '/debug', description: 'Return diagnostics focused facts' },
      ],
    };
  }

  async runMessage(input: ProviderRunMessageInput): Promise<ProviderRun> {
    if (this.#manualAgent.enabled) {
      this.#events.append('provider.call', 'Provider runMessage called in manual mode', {
        command: 'runMessage',
        input,
        rawInputText: safeJsonText(input),
        scenario: { command: 'runMessage', kind: 'manual' },
      });
      return this.#manualAgent.startRun(input);
    }
    const scenario = await this.#beforeCall('runMessage', input);
    const facts = factStreamForScenario(scenario.kind);
    return {
      runId: input.runId,
      facts,
      async result() {
        if (scenario.kind === 'failed_run') {
          return {
            outcome: 'failed',
            error: {
              code: 'internal_error',
              message: 'SDK lab configured failed run',
            },
          };
        }
        if (scenario.kind === 'session_not_found') {
          return {
            outcome: 'failed',
            error: {
              code: 'session_not_found',
              message: 'SDK lab configured missing session',
            },
          };
        }
        if (scenario.kind === 'result_reject') {
          throw new Error('SDK lab configured ProviderRun.result rejection');
        }
        if (scenario.kind === 'aborted_run') {
          return { outcome: 'aborted' };
        }
        return { outcome: 'completed' };
      },
    };
  }

  async replyQuestion(input: ProviderQuestionReplyInput): Promise<AppliedResult> {
    await this.#beforeCall('replyQuestion', input);
    return { applied: true };
  }

  async replyPermission(input: ProviderPermissionReplyInput): Promise<AppliedResult> {
    await this.#beforeCall('replyPermission', input);
    return { applied: true };
  }

  async closeSession(input: ProviderCloseSessionInput): Promise<AppliedResult> {
    await this.#beforeCall('closeSession', input);
    return { applied: true };
  }

  async abortSession(input: ProviderAbortSessionInput): Promise<AppliedResult> {
    await this.#beforeCall('abortSession', input);
    return { applied: true };
  }

  async dispose(): Promise<void> {
    await this.#beforeCall('dispose', {});
    this.#context = undefined;
  }

  async emitOutboundRun(kind?: ProviderScenarioKind): Promise<AppliedResult> {
    if (!this.#context) {
      throw new Error('Provider runtime context is not initialized');
    }
    const scenario = kind ? { ...DEFAULT_SCENARIO, command: 'outbound', kind } : this.#scenarioFor('outbound');
    return this.#context.outbound.emitOutboundRun({
      toolSessionId: `ses_${crypto.randomUUID()}`,
      runId: `run_${crypto.randomUUID()}`,
      trigger: 'sdk-lab',
      facts: factStreamForScenario(scenario.kind),
    });
  }

  async emitManualOutboundRun(input: {
    toolSessionId: string;
    runId: string;
    trigger: string;
    facts: ProviderFact[];
  }): Promise<AppliedResult> {
    if (!this.#context) {
      throw new Error('Provider runtime context is not initialized');
    }
    this.#events.append('provider.outbound.manual', 'Provider manual outbound run emitted', {
      input,
      rawInputText: safeJsonText(input),
    });
    return this.#context.outbound.emitOutboundRun({
      toolSessionId: input.toolSessionId,
      runId: input.runId,
      trigger: input.trigger,
      facts: toAsyncIterable(input.facts),
    });
  }

  async #beforeCall(command: string, input: unknown): Promise<ProviderScenarioConfig> {
    const scenario = this.#scenarioFor(command);
    this.#events.append('provider.call', `Provider ${command} called`, {
      command,
      input,
      rawInputText: safeJsonText(input),
      scenario,
    });
    await delay(scenario.delayMs ?? 0);
    this.#throwIfNeeded(command, scenario.kind);
    if (scenario.kind === 'timeout') {
      await delay(30_000);
    }
    return scenario;
  }

  async #maybeDelay(command: string): Promise<void> {
    const scenario = this.#scenarioFor(command);
    await delay(scenario.delayMs ?? 0);
  }

  #throwIfNeeded(command: string, kind = this.#scenarioFor(command).kind): void {
    if (kind === 'throw') {
      throw new Error(`SDK lab configured ${command} failure`);
    }
  }

  #scenarioFor(command: string): ProviderScenarioConfig {
    return this.#scenarios.get(command) ?? this.#scenarios.get('*') ?? DEFAULT_SCENARIO;
  }
}

type AppliedResult = {
  applied: true;
};

async function* defaultFactStream(): AsyncIterable<ProviderFact> {
  const messageId = `msg_${crypto.randomUUID()}`;
  const textPartId = `prt_${crypto.randomUUID()}`;
  const toolPartId = `prt_${crypto.randomUUID()}`;
  yield { type: 'message.start', messageId };
  yield { type: 'thinking.delta', messageId, partId: `prt_${crypto.randomUUID()}`, content: 'Planning response' };
  yield { type: 'tool.update', messageId, partId: toolPartId, toolCallId: `tool_${crypto.randomUUID()}`, toolName: 'sdk_lab_probe', status: 'running', input: { source: 'sdk-lab' } };
  yield { type: 'text.delta', messageId, partId: textPartId, content: 'SDK lab response chunk' };
  yield { type: 'text.done', messageId, partId: textPartId, content: 'SDK lab response chunk' };
  yield { type: 'message.done', messageId, reason: 'completed' };
}

async function* toAsyncIterable(facts: ProviderFact[]): AsyncIterable<ProviderFact> {
  for (const fact of facts) {
    yield fact;
  }
}

async function* invalidFactStream(): AsyncIterable<ProviderFact> {
  yield {
    type: 'text.delta',
    messageId: `msg_${crypto.randomUUID()}`,
    partId: `prt_${crypto.randomUUID()}`,
    content: 'missing message.start',
  };
}

async function* throwingFactStream(): AsyncIterable<ProviderFact> {
  yield { type: 'message.start', messageId: `msg_${crypto.randomUUID()}` };
  throw new Error('SDK lab configured facts iterator failure');
}

async function* enrichFailureFactStream(): AsyncIterable<ProviderFact> {
  const messageId = `msg_${crypto.randomUUID()}`;
  yield {
    type: 'permission.reply',
    permissionId: `permission_${crypto.randomUUID()}`,
    response: 'once',
  };
  yield { type: 'message.start', messageId };
  yield { type: 'message.done', messageId, reason: 'completed' };
}

async function* questionConflictFactStream(): AsyncIterable<ProviderFact> {
  const messageId = `msg_${crypto.randomUUID()}`;
  yield { type: 'message.start', messageId };
  yield {
    type: 'question.ask',
    messageId,
    partId: `prt_${crypto.randomUUID()}`,
    questionId: 'question-conflict-fixed',
    questions: [
      {
        question: '请选择一个固定问题选项',
        options: [
          { label: 'yes' },
          { label: 'no' },
        ],
      },
    ],
  };
  yield { type: 'message.done', messageId, reason: 'completed' };
}

async function* permissionConflictFactStream(): AsyncIterable<ProviderFact> {
  const messageId = `msg_${crypto.randomUUID()}`;
  yield { type: 'message.start', messageId };
  yield {
    type: 'permission.ask',
    messageId,
    partId: `prt_${crypto.randomUUID()}`,
    permissionId: 'permission-conflict-fixed',
    permType: 'sdk-lab',
    title: '允许执行固定授权请求',
  };
  yield { type: 'message.done', messageId, reason: 'completed' };
}

function factStreamForScenario(kind: ProviderScenarioKind): AsyncIterable<ProviderFact> {
  switch (kind) {
    case 'invalid_fact':
      return invalidFactStream();
    case 'facts_throw':
      return throwingFactStream();
    case 'enrich_failure':
      return enrichFailureFactStream();
    case 'question_conflict':
      return questionConflictFactStream();
    case 'permission_conflict':
      return permissionConflictFactStream();
    default:
      return defaultFactStream();
  }
}

function safeJsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
