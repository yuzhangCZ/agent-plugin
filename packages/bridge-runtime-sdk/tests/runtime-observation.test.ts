import test from 'node:test';
import assert from 'node:assert/strict';

import type { BridgeGatewayLogger } from '../src/infrastructure/gateway/gateway-host.ts';
import {
  BridgeGatewayLoggerObservationAdapter,
} from '../src/adapters/observation/runtime-logger-observation.ts';
import {
  CompositeRuntimeObservationPort,
  DefaultRuntimeObservation,
  type RuntimeObservationEvent,
  type RuntimeObservationPort,
} from '../src/application/runtime-observation/index.ts';
import { RuntimeTraceCollectorAdapter } from '../src/adapters/observation/runtime-trace-observation.ts';
import {
  ObservedProviderCommandHandlers,
  type ProviderCommandHandlers,
} from '../src/adapters/provider/provider-api-adapter.ts';
import {
  AbortExecutionUseCase,
  CloseSessionUseCase,
  CreateSessionUseCase,
  QueryStatusUseCase,
  ReplyPermissionUseCase,
  ReplyQuestionUseCase,
} from '../src/application/usecases/index.ts';
import { InteractionCoordinator } from '../src/application/coordinators/index.ts';
import type { PendingInteractionRegistry } from '../src/application/ports/pending-interaction-registry.ts';
import type { SessionRuntimeRegistry } from '../src/application/ports/session-runtime-registry.ts';

class StubSessionRuntimeRegistry implements SessionRuntimeRegistry {
  ensure(input: { toolSessionId: string; welinkSessionId?: string }) {
    return {
      toolSessionId: input.toolSessionId,
      welinkSessionId: input.welinkSessionId,
      lifecycle: 'active' as const,
    };
  }

  get(toolSessionId: string) {
    return {
      toolSessionId,
      lifecycle: 'active' as const,
      activeRunId: 'run-active',
    };
  }

  delete(): void {}

  acquireActiveRun(toolSessionId: string, runId: string) {
    return {
      ok: true as const,
      record: {
        toolSessionId,
        lifecycle: 'active' as const,
        activeRunId: runId,
      },
    };
  }

  releaseActiveRun(): void {}

  acquireActiveOutbound(toolSessionId: string, messageId: string) {
    return {
      ok: true as const,
      record: {
        toolSessionId,
        lifecycle: 'active' as const,
        activeOutboundMessageId: messageId,
      },
    };
  }

  releaseActiveOutbound(): void {}

  markAborting(toolSessionId: string) {
    return {
      toolSessionId,
      lifecycle: 'aborting' as const,
    };
  }

  markClosed(toolSessionId: string) {
    return {
      toolSessionId,
      lifecycle: 'closed' as const,
    };
  }
}

class StubPendingInteractionRegistry implements PendingInteractionRegistry {
  consume(input: { kind: 'question' | 'permission'; tokenId: string }) {
    return {
      toolSessionId: `${input.kind}-tool`,
      kind: input.kind,
      tokenId: input.tokenId,
    };
  }

  register() {
    return { ok: true as const };
  }

  clearSession(): void {}
}

type RecordedLog = {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
};

class RecordingLogger implements BridgeGatewayLogger {
  readonly logs: RecordedLog[] = [];

  debug(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'debug', message, meta });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'info', message, meta });
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'warn', message, meta });
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'error', message, meta });
  }
}

class RecordingObservationPort implements RuntimeObservationPort {
  readonly events: RuntimeObservationEvent[] = [];

  record(event: RuntimeObservationEvent): void {
    this.events.push(event);
  }
}

function hasLog(logs: RecordedLog[], message: string, level?: RecordedLog['level']): boolean {
  return logs.some((log) => log.message === message && (!level || log.level === level));
}

test('logger observation adapter projects observation events into runtime_sdk logs', () => {
  const logger = new RecordingLogger();
  const adapter = new BridgeGatewayLoggerObservationAdapter(logger);

  adapter.record({ type: 'runtime_lifecycle', action: 'start_requested' });
  adapter.record({
    type: 'provider_call',
    phase: 'started',
    command: 'startRequestRun',
    traceId: 'trace-1',
    toolSessionId: 'tool-1',
    runId: 'run-1',
  });
  adapter.record({
    type: 'provider_call',
    phase: 'failed',
    command: 'startRequestRun',
    traceId: 'trace-1',
    toolSessionId: 'tool-1',
    runId: 'run-1',
    error: 'provider_unavailable',
  });
  adapter.record({
    type: 'fact_processed',
    phase: 'received',
    toolSessionId: 'tool-1',
    fact: { type: 'message.start', messageId: 'msg-1' },
    profile: 'request_run',
  });

  assert.equal(hasLog(logger.logs, 'runtime_sdk.start.requested', 'info'), true);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.provider.startRequestRun.started', 'debug'), true);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.provider.startRequestRun.failed', 'error'), true);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.fact.received', 'debug'), true);
});

test('default runtime observation maps semantic methods into standard events', () => {
  const port = new RecordingObservationPort();
  const observation = new DefaultRuntimeObservation(port);

  observation.runtimeCoreStarted();
  observation.usecaseConflict('start_request_run', 'trace-1', new Error('run busy'), 'run_already_active', {
    toolSessionId: 'tool-1',
    welinkSessionId: 'we-1',
    runId: 'run-1',
  });
  observation.providerCallFailed('startRequestRun', 'trace-2', new Error('provider_down'), undefined, {
    toolSessionId: 'tool-2',
    runId: 'run-2',
  });
  observation.invalidInvokeRejected(
    {
      toolSessionId: 'tool-3',
      welinkSessionId: 'we-3',
    },
    new Error('invalid payload'),
    'payload_invalid',
  );

  assert.deepEqual(port.events, [
    {
      type: 'runtime_lifecycle',
      action: 'core_started',
    },
    {
      type: 'usecase_progress',
      phase: 'conflict',
      usecase: 'start_request_run',
      traceId: 'trace-1',
      toolSessionId: 'tool-1',
      welinkSessionId: 'we-1',
      runId: 'run-1',
      error: 'run busy',
      code: 'run_already_active',
    },
    {
      type: 'provider_call',
      phase: 'failed',
      command: 'startRequestRun',
      traceId: 'trace-2',
      toolSessionId: 'tool-2',
      runId: 'run-2',
      error: 'provider_down',
      code: undefined,
    },
    {
      type: 'downstream_processed',
      action: 'invalid_invoke_rejected',
      messageType: 'invoke',
      toolSessionId: 'tool-3',
      welinkSessionId: 'we-3',
      error: 'invalid payload',
      code: 'payload_invalid',
    },
  ]);
});

test('trace observation adapter keeps diagnostics in sync with observation events', () => {
  const trace = new RuntimeTraceCollectorAdapter();
  const observation = new CompositeRuntimeObservationPort([trace]);

  observation.record({
    type: 'gateway_state_changed',
    state: 'READY',
    occurredAt: 123,
  });
  observation.record({
    type: 'gateway_activity',
    activity: 'inbound',
    occurredAt: 456,
  });
  observation.record({
    type: 'provider_call',
    phase: 'started',
    command: 'createSession',
    toolSessionId: 'tool-1',
  });
  observation.record({
    type: 'fact_processed',
    phase: 'received',
    toolSessionId: 'tool-1',
    fact: { type: 'message.start', messageId: 'msg-1' },
    profile: 'request_run',
  });
  observation.record({
    type: 'uplink_emitted',
    message: { type: 'tool_done', toolSessionId: 'tool-1' },
  });
  observation.record({
    type: 'terminal_progress',
    phase: 'received',
    toolSessionId: 'tool-1',
    result: { outcome: 'completed' },
  });
  observation.record({
    type: 'interaction_changed',
    action: 'register',
    kind: 'question',
    toolSessionId: 'tool-1',
    tokenId: 'question-1',
  });
  observation.record({
    type: 'failure_recorded',
    kind: 'command_execution_failure',
    phase: 'runtime',
    message: 'provider failed',
  });

  const diagnostics = trace.snapshot();
  assert.equal(diagnostics.gatewayState, 'READY');
  assert.equal(diagnostics.lastReadyAt, 123);
  assert.equal(diagnostics.lastInboundAt, 456);
  assert.deepEqual(diagnostics.providerCalls[0], {
    command: 'createSession',
    toolSessionId: 'tool-1',
  });
  assert.deepEqual(diagnostics.facts[0], {
    type: 'message.start',
    toolSessionId: 'tool-1',
    messageId: 'msg-1',
  });
  assert.deepEqual(diagnostics.uplinks[0], {
    type: 'tool_done',
    toolSessionId: 'tool-1',
  });
  assert.deepEqual(diagnostics.terminals[0], {
    toolSessionId: 'tool-1',
    outcome: 'completed',
  });
  assert.deepEqual(diagnostics.interactions[0], {
    action: 'register',
    kind: 'question',
    toolSessionId: 'tool-1',
    tokenId: 'question-1',
  });
  assert.deepEqual(diagnostics.failures[0], {
    kind: 'command_execution_failure',
    phase: 'runtime',
    message: 'provider failed',
    code: undefined,
  });
});

test('observed provider handlers emit started and failed observation events', async () => {
  const port = new RecordingObservationPort();
  const observation = new DefaultRuntimeObservation(port);
  const handlers: ProviderCommandHandlers = new ObservedProviderCommandHandlers(
    {
      async queryStatus() {
        throw new Error('provider_down');
      },
      async createSession() {
        return { toolSessionId: 'tool-1' };
      },
      async startRequestRun() {
        return {
          runId: 'run-1',
          facts: (async function* () {})(),
          async result() {
            return { outcome: 'completed' as const };
          },
        };
      },
      async replyQuestion() {
        return { applied: true };
      },
      async replyPermission() {
        return { applied: true };
      },
      async closeSession() {
        return { applied: true };
      },
      async abortExecution() {
        return { applied: true };
      },
    },
    observation,
  );

  await assert.rejects(() => handlers.queryStatus({ traceId: 'trace-1' }), /provider_down/);
  assert.deepEqual(port.events, [
    {
      type: 'provider_call',
      phase: 'started',
      command: 'queryStatus',
      traceId: 'trace-1',
    },
    {
      type: 'provider_call',
      phase: 'failed',
      command: 'queryStatus',
      traceId: 'trace-1',
      error: 'provider_down',
      code: undefined,
    },
  ]);
});

test('usecases emit failed observation events for non request-run failures', async () => {
  const queryPort = new RecordingObservationPort();
  const queryObservation = new DefaultRuntimeObservation(queryPort);
  const queryUseCase = new QueryStatusUseCase(
    {
      async queryStatus() {
        throw new Error('query_failed');
      },
      async createSession() {
        throw new Error('unexpected');
      },
      async startRequestRun() {
        throw new Error('unexpected');
      },
      async replyQuestion() {
        throw new Error('unexpected');
      },
      async replyPermission() {
        throw new Error('unexpected');
      },
      async closeSession() {
        throw new Error('unexpected');
      },
      async abortExecution() {
        throw new Error('unexpected');
      },
    },
    { send() {} },
    {
      projectStatus() {
        return { type: 'status_response', opencodeOnline: true };
      },
      projectSessionCreated() {
        return {
          type: 'session_created',
          welinkSessionId: 'unused',
          toolSessionId: 'unused',
          session: { sessionId: 'unused' },
        };
      },
    },
    queryObservation,
  );

  await assert.rejects(
    () => queryUseCase.execute({ kind: 'query_status', traceId: 'trace-query', source: { type: 'status_query' } } as never),
    /query_failed/,
  );
  assert.deepEqual(queryPort.events, [
    { type: 'usecase_progress', phase: 'started', usecase: 'query_status', traceId: 'trace-query' },
    {
      type: 'usecase_progress',
      phase: 'failed',
      usecase: 'query_status',
      traceId: 'trace-query',
      error: 'query_failed',
      code: undefined,
    },
  ]);

  const createPort = new RecordingObservationPort();
  const createObservation = new DefaultRuntimeObservation(createPort);
  const createUseCase = new CreateSessionUseCase(
    {
      async queryStatus() {
        throw new Error('unexpected');
      },
      async createSession() {
        throw new Error('create_failed');
      },
      async startRequestRun() {
        throw new Error('unexpected');
      },
      async replyQuestion() {
        throw new Error('unexpected');
      },
      async replyPermission() {
        throw new Error('unexpected');
      },
      async closeSession() {
        throw new Error('unexpected');
      },
      async abortExecution() {
        throw new Error('unexpected');
      },
    },
    new StubSessionRuntimeRegistry(),
    { send() {} },
    {
      projectStatus() {
        return { type: 'status_response', opencodeOnline: true };
      },
      projectSessionCreated() {
        return {
          type: 'session_created',
          welinkSessionId: 'we-1',
          toolSessionId: 'tool-1',
          session: { sessionId: 'tool-1' },
        };
      },
    },
    createObservation,
  );

  await assert.rejects(
    () => createUseCase.execute({
      kind: 'create_session',
      traceId: 'trace-create',
      source: {
        type: 'invoke',
        action: 'create_session',
        welinkSessionId: 'we-1',
        payload: { title: 't', assistantId: 'a' },
      },
    } as never),
    /create_failed/,
  );
  assert.deepEqual(createPort.events, [
    {
      type: 'usecase_progress',
      phase: 'started',
      usecase: 'create_session',
      traceId: 'trace-create',
      welinkSessionId: 'we-1',
    },
    {
      type: 'usecase_progress',
      phase: 'failed',
      usecase: 'create_session',
      traceId: 'trace-create',
      welinkSessionId: 'we-1',
      error: 'create_failed',
      code: undefined,
    },
  ]);

  const interactionObservation = new DefaultRuntimeObservation(new RecordingObservationPort());
  const interactionCoordinator = new InteractionCoordinator(new StubPendingInteractionRegistry(), interactionObservation);

  const replyQuestionPort = new RecordingObservationPort();
  const replyQuestionObservation = new DefaultRuntimeObservation(replyQuestionPort);
  const replyQuestionUseCase = new ReplyQuestionUseCase(
    {
      async queryStatus() {
        throw new Error('unexpected');
      },
      async createSession() {
        throw new Error('unexpected');
      },
      async startRequestRun() {
        throw new Error('unexpected');
      },
      async replyQuestion() {
        throw new Error('reply_question_failed');
      },
      async replyPermission() {
        throw new Error('unexpected');
      },
      async closeSession() {
        throw new Error('unexpected');
      },
      async abortExecution() {
        throw new Error('unexpected');
      },
    },
    interactionCoordinator,
    replyQuestionObservation,
  );

  await assert.rejects(
    () => replyQuestionUseCase.execute({
      kind: 'reply_question',
      traceId: 'trace-question',
      source: {
        type: 'invoke',
        action: 'question_reply',
        payload: { questionId: 'q-1', answer: 'yes' },
      },
    } as never),
    /reply_question_failed/,
  );
  assert.deepEqual(replyQuestionPort.events, [
    {
      type: 'usecase_progress',
      phase: 'started',
      usecase: 'reply_question',
      traceId: 'trace-question',
    },
    {
      type: 'usecase_progress',
      phase: 'failed',
      usecase: 'reply_question',
      traceId: 'trace-question',
      error: 'reply_question_failed',
      code: undefined,
    },
  ]);

  const replyPermissionPort = new RecordingObservationPort();
  const replyPermissionObservation = new DefaultRuntimeObservation(replyPermissionPort);
  const replyPermissionUseCase = new ReplyPermissionUseCase(
    {
      async queryStatus() {
        throw new Error('unexpected');
      },
      async createSession() {
        throw new Error('unexpected');
      },
      async startRequestRun() {
        throw new Error('unexpected');
      },
      async replyQuestion() {
        throw new Error('unexpected');
      },
      async replyPermission() {
        throw new Error('reply_permission_failed');
      },
      async closeSession() {
        throw new Error('unexpected');
      },
      async abortExecution() {
        throw new Error('unexpected');
      },
    },
    interactionCoordinator,
    replyPermissionObservation,
  );

  await assert.rejects(
    () => replyPermissionUseCase.execute({
      kind: 'reply_permission',
      traceId: 'trace-permission',
      source: {
        type: 'invoke',
        action: 'permission_reply',
        payload: { permissionId: 'p-1', response: 'allow' },
      },
    } as never),
    /reply_permission_failed/,
  );
  assert.deepEqual(replyPermissionPort.events, [
    {
      type: 'usecase_progress',
      phase: 'started',
      usecase: 'reply_permission',
      traceId: 'trace-permission',
    },
    {
      type: 'usecase_progress',
      phase: 'failed',
      usecase: 'reply_permission',
      traceId: 'trace-permission',
      error: 'reply_permission_failed',
      code: undefined,
    },
  ]);

  const closePort = new RecordingObservationPort();
  const closeObservation = new DefaultRuntimeObservation(closePort);
  const closeUseCase = new CloseSessionUseCase(
    {
      async queryStatus() {
        throw new Error('unexpected');
      },
      async createSession() {
        throw new Error('unexpected');
      },
      async startRequestRun() {
        throw new Error('unexpected');
      },
      async replyQuestion() {
        throw new Error('unexpected');
      },
      async replyPermission() {
        throw new Error('unexpected');
      },
      async closeSession() {
        throw new Error('close_failed');
      },
      async abortExecution() {
        throw new Error('unexpected');
      },
    },
    new StubSessionRuntimeRegistry(),
    interactionCoordinator,
    closeObservation,
  );

  await assert.rejects(
    () => closeUseCase.execute({
      kind: 'close_session',
      traceId: 'trace-close',
      source: {
        type: 'invoke',
        action: 'close_session',
        payload: { toolSessionId: 'tool-close' },
      },
    } as never),
    /close_failed/,
  );
  assert.deepEqual(closePort.events, [
    {
      type: 'usecase_progress',
      phase: 'started',
      usecase: 'close_session',
      traceId: 'trace-close',
      toolSessionId: 'tool-close',
    },
    {
      type: 'usecase_progress',
      phase: 'failed',
      usecase: 'close_session',
      traceId: 'trace-close',
      toolSessionId: 'tool-close',
      error: 'close_failed',
      code: undefined,
    },
  ]);

  const abortPort = new RecordingObservationPort();
  const abortObservation = new DefaultRuntimeObservation(abortPort);
  const abortUseCase = new AbortExecutionUseCase(
    {
      async queryStatus() {
        throw new Error('unexpected');
      },
      async createSession() {
        throw new Error('unexpected');
      },
      async startRequestRun() {
        throw new Error('unexpected');
      },
      async replyQuestion() {
        throw new Error('unexpected');
      },
      async replyPermission() {
        throw new Error('unexpected');
      },
      async closeSession() {
        throw new Error('unexpected');
      },
      async abortExecution() {
        throw new Error('abort_failed');
      },
    },
    new StubSessionRuntimeRegistry(),
    abortObservation,
  );

  await assert.rejects(
    () => abortUseCase.execute({
      kind: 'abort_execution',
      traceId: 'trace-abort',
      source: {
        type: 'invoke',
        action: 'abort_session',
        payload: { toolSessionId: 'tool-abort' },
      },
    } as never),
    /abort_failed/,
  );
  assert.deepEqual(abortPort.events, [
    {
      type: 'usecase_progress',
      phase: 'started',
      usecase: 'abort_execution',
      traceId: 'trace-abort',
      toolSessionId: 'tool-abort',
      runId: 'run-active',
    },
    {
      type: 'usecase_progress',
      phase: 'failed',
      usecase: 'abort_execution',
      traceId: 'trace-abort',
      toolSessionId: 'tool-abort',
      runId: 'run-active',
      error: 'abort_failed',
      code: undefined,
    },
  ]);
});
