import type {
  ManualAgentContext,
  ManualAgentFactResult,
  ManualAgentSnapshot,
  ManualAgentTemplate,
  ManualAgentTerminalInput,
} from '@agent-plugin/bridge-runtime-sdk-lab-shared';
import type { ProviderFact, ProviderRun, ProviderRunMessageInput, ProviderTerminalResult } from '@wecode/bridge-runtime-sdk';

import { EventStore } from './event-store.ts';
import { asRecord } from './sanitize.ts';

interface ManualRunState {
  context: ManualAgentContext;
  queue: ProviderFact[];
  waiters: Array<(result: IteratorResult<ProviderFact>) => void>;
  terminal?: ProviderTerminalResult;
  terminalResolve: (result: ProviderTerminalResult) => void;
  terminalPromise: Promise<ProviderTerminalResult>;
  factsClosed: boolean;
}

export class ManualAgentController {
  readonly #events: EventStore;
  #enabled = false;
  #activeRun: ManualRunState | undefined;

  constructor(events: EventStore) {
    this.#events = events;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(enabled: boolean): ManualAgentSnapshot {
    this.#enabled = enabled;
    if (!enabled) {
      this.finishActiveRun({ outcome: 'aborted' });
    }
    this.#events.append('manual_agent.mode.changed', `Manual agent mode ${enabled ? 'enabled' : 'disabled'}`, { enabled });
    return this.snapshot();
  }

  startRun(input: ProviderRunMessageInput): ProviderRun {
    this.finishActiveRun({ outcome: 'aborted' });
    const context: ManualAgentContext = {
      runId: input.runId,
      traceId: input.traceId,
      toolSessionId: input.toolSessionId,
      text: input.text,
      messageId: `msg_${crypto.randomUUID()}`,
      textPartId: `prt_${crypto.randomUUID()}`,
      thinkingPartId: `prt_${crypto.randomUUID()}`,
      toolPartId: `prt_${crypto.randomUUID()}`,
      toolCallId: `tool_${crypto.randomUUID()}`,
    };

    let terminalResolve!: (result: ProviderTerminalResult) => void;
    const terminalPromise = new Promise<ProviderTerminalResult>((resolve) => {
      terminalResolve = resolve;
    });
    const state: ManualRunState = {
      context,
      queue: [],
      waiters: [],
      terminalResolve,
      terminalPromise,
      factsClosed: false,
    };
    this.#activeRun = state;
    this.#events.append('manual_agent.run.started', 'Manual ProviderFact run started', { context });
    return {
      runId: input.runId,
      facts: this.createFactStream(state),
      result: () => terminalPromise,
    };
  }

  submitFact(value: unknown): ManualAgentFactResult {
    const state = this.requireActiveRun();
    const fact = normalizeProviderFact(value);
    this.enqueueFact(state, fact);
    return {
      accepted: true,
      queuedFactCount: state.queue.length,
      submittedFactCount: 1,
    };
  }

  submitTextResponse(value: unknown): ManualAgentFactResult {
    const state = this.requireActiveRun();
    const textDoneFact = normalizeTextDoneFact(value, state.context);
    const content = typeof textDoneFact.content === 'string' ? textDoneFact.content : 'Manual response chunk';
    const facts: ProviderFact[] = [
      { type: 'message.start', messageId: textDoneFact.messageId },
      {
        type: 'text.delta',
        messageId: textDoneFact.messageId,
        partId: textDoneFact.partId,
        content,
      },
      textDoneFact,
      { type: 'message.done', messageId: textDoneFact.messageId, reason: 'completed' },
    ];
    for (const fact of facts) {
      this.enqueueFact(state, fact);
    }
    this.#events.append('manual_agent.text_response.submitted', 'Manual text response facts submitted', {
      textDoneFact,
      submittedFactCount: facts.length,
      queuedFactCount: state.queue.length,
      context: state.context,
    });
    return {
      accepted: true,
      queuedFactCount: state.queue.length,
      submittedFactCount: facts.length,
    };
  }

  finishActiveRun(input: ManualAgentTerminalInput): ManualAgentSnapshot {
    const state = this.#activeRun;
    if (!state || state.terminal) {
      return this.snapshot();
    }
    const terminal = toTerminalResult(input);
    state.terminal = terminal;
    state.factsClosed = true;
    for (const waiter of state.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
    state.terminalResolve(terminal);
    this.#events.append('manual_agent.run.finished', `Manual ProviderFact run finished: ${terminal.outcome}`, {
      terminal,
      context: state.context,
    });
    this.#activeRun = undefined;
    return this.snapshot();
  }

  snapshot(): ManualAgentSnapshot {
    return {
      enabled: this.#enabled,
      activeRun: this.#activeRun?.context,
      queuedFactCount: this.#activeRun?.queue.length ?? 0,
    };
  }

  templates(): ManualAgentTemplate[] {
    const context = this.#activeRun?.context ?? createPlaceholderContext();
    return createTemplates(context);
  }

  private async *createFactStream(state: ManualRunState): AsyncIterable<ProviderFact> {
    while (!state.factsClosed || state.queue.length > 0) {
      const queued = state.queue.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (state.factsClosed) {
        return;
      }
      const next = await new Promise<IteratorResult<ProviderFact>>((resolve) => {
        state.waiters.push(resolve);
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }

  private requireActiveRun(): ManualRunState {
    if (!this.#activeRun) {
      throw new Error('Manual agent has no active run. Enable manual mode and send a chat message first.');
    }
    return this.#activeRun;
  }

  private enqueueFact(state: ManualRunState, fact: ProviderFact): void {
    if (state.factsClosed) {
      throw new Error('Manual run facts are already closed');
    }
    const waiter = state.waiters.shift();
    if (waiter) {
      waiter({ value: fact, done: false });
    } else {
      state.queue.push(fact);
    }
    this.#events.append('manual_agent.fact.submitted', `Manual ProviderFact submitted: ${fact.type}`, {
      fact,
      queuedFactCount: state.queue.length,
    });
  }
}

function normalizeProviderFact(value: unknown): ProviderFact {
  const record = asRecord(value);
  if (!record || typeof record.type !== 'string') {
    throw new Error('ProviderFact must be a JSON object with a string type');
  }
  return record as unknown as ProviderFact;
}

function normalizeTextDoneFact(value: unknown, context: ManualAgentContext): Extract<ProviderFact, { type: 'text.done' }> {
  const record = asRecord(value);
  if (!record || record.type !== 'text.done') {
    throw new Error('Text response shortcut requires the editor JSON to be a text.done ProviderFact');
  }
  return {
    ...record,
    type: 'text.done',
    messageId: typeof record.messageId === 'string' && record.messageId.length > 0 ? record.messageId : context.messageId,
    partId: typeof record.partId === 'string' && record.partId.length > 0 ? record.partId : context.textPartId,
    content: typeof record.content === 'string' ? record.content : 'Manual response chunk',
  } as Extract<ProviderFact, { type: 'text.done' }>;
}

function toTerminalResult(input: ManualAgentTerminalInput): ProviderTerminalResult {
  if (input.outcome === 'failed') {
    return {
      outcome: 'failed',
      error: {
        code: toProviderErrorCode(input.code),
        message: input.message ?? 'Manual agent reported failure',
      },
    };
  }
  return { outcome: input.outcome };
}

function toProviderErrorCode(value: string | undefined): NonNullable<ProviderTerminalResult['error']>['code'] {
  switch (value) {
    case 'timeout':
    case 'session_not_found':
    case 'invalid_input':
    case 'not_found':
    case 'not_supported':
    case 'provider_unavailable':
    case 'internal_error':
    case 'rate_limited':
      return value;
    default:
      return 'internal_error';
  }
}

function createPlaceholderContext(): ManualAgentContext {
  return {
    runId: 'run_pending',
    traceId: 'trace_pending',
    toolSessionId: 'tool_pending',
    text: 'pending user message',
    messageId: 'msg_manual',
    textPartId: 'prt_text_manual',
    thinkingPartId: 'prt_thinking_manual',
    toolPartId: 'prt_tool_manual',
    toolCallId: 'tool_call_manual',
  };
}

function createTemplates(context: ManualAgentContext): ManualAgentTemplate[] {
  return [
    {
      id: 'message.start',
      title: 'message.start',
      description: '开始一条 assistant 消息。',
      fact: { type: 'message.start', messageId: context.messageId },
    },
    {
      id: 'thinking.delta',
      title: 'thinking.delta',
      description: '输出思考片段。',
      fact: {
        type: 'thinking.delta',
        messageId: context.messageId,
        partId: context.thinkingPartId,
        content: 'Planning response',
      },
    },
    {
      id: 'text.delta',
      title: 'text.delta',
      description: '输出正文增量。',
      fact: {
        type: 'text.delta',
        messageId: context.messageId,
        partId: context.textPartId,
        content: 'Manual response chunk',
      },
    },
    {
      id: 'text.done',
      title: 'text.done',
      description: '结束正文 part。',
      fact: {
        type: 'text.done',
        messageId: context.messageId,
        partId: context.textPartId,
        content: 'Manual response chunk',
      },
    },
    {
      id: 'tool.update.running',
      title: 'tool.update running',
      description: '上报工具调用运行中。',
      fact: {
        type: 'tool.update',
        messageId: context.messageId,
        partId: context.toolPartId,
        toolCallId: context.toolCallId,
        toolName: 'manual_tool',
        status: 'running',
        input: { source: 'sdk-lab' },
      },
    },
    {
      id: 'tool.update.completed',
      title: 'tool.update completed',
      description: '上报工具调用完成。',
      fact: {
        type: 'tool.update',
        messageId: context.messageId,
        partId: context.toolPartId,
        toolCallId: context.toolCallId,
        toolName: 'manual_tool',
        status: 'completed',
        output: 'manual tool output',
      },
    },
    {
      id: 'question.ask',
      title: 'question.ask',
      description: '上报问题交互。',
      fact: {
        type: 'question.ask',
        messageId: context.messageId,
        partId: `prt_question_${crypto.randomUUID()}`,
        questionId: `question_${crypto.randomUUID()}`,
        questions: [
          {
            question: '请选择一个选项',
            options: [{ label: '继续', description: '继续当前任务' }],
          },
        ],
      },
    },
    {
      id: 'permission.ask',
      title: 'permission.ask',
      description: '上报权限申请。',
      fact: {
        type: 'permission.ask',
        messageId: context.messageId,
        partId: `prt_permission_${crypto.randomUUID()}`,
        permissionId: `permission_${crypto.randomUUID()}`,
        permType: 'manual',
        title: '允许执行 manual_tool',
      },
    },
    {
      id: 'session.title',
      title: 'session.title',
      description: '更新会话标题。',
      fact: { type: 'session.title', title: 'Manual SDK Lab Session' },
    },
    {
      id: 'session.error',
      title: 'session.error',
      description: '上报会话级错误事实。',
      fact: {
        type: 'session.error',
        error: {
          code: 'manual_session_error',
          message: 'Manual session error',
        },
      },
    },
    {
      id: 'message.done',
      title: 'message.done',
      description: '结束 assistant 消息。',
      fact: { type: 'message.done', messageId: context.messageId, reason: 'completed' },
    },
  ];
}
