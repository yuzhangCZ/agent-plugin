import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeContractError } from '@/domain/errors.ts';
import { StartRequestRunUseCase } from '@/application/usecases/index.ts';

class RecordingObservation {
  readonly events: Array<{ method: string; args: unknown[] }> = [];

  usecaseStarted(...args: unknown[]): void {
    this.events.push({ method: 'usecaseStarted', args });
  }

  usecaseSucceeded(...args: unknown[]): void {
    this.events.push({ method: 'usecaseSucceeded', args });
  }

  usecaseFailed(...args: unknown[]): void {
    this.events.push({ method: 'usecaseFailed', args });
  }

  usecaseConflict(...args: unknown[]): void {
    this.events.push({ method: 'usecaseConflict', args });
  }
}

function createCommand(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'start_request_run',
    traceId: 'trace-run',
    source: {
      type: 'invoke',
      action: 'chat',
      welinkSessionId: 'we-1',
      suppressReply: true,
      payload: {
        toolSessionId: 'tool-1',
        text: 'hello',
        assistantId: 'assistant-1',
        assistantAccount: 'assistant-account',
        sendUserAccount: 'sender-account',
        extParameters: { channel: 'test' },
      },
      ...overrides,
    },
  } as never;
}

test('StartRequestRunUseCase acquires request run, calls provider, delegates run, then releases lock', async () => {
  const observation = new RecordingObservation();
  const providerCalls: unknown[] = [];
  const coordinatorCalls: unknown[] = [];
  const released: Array<{ toolSessionId: string; runId: string }> = [];
  const providerRun = {
    runId: 'provider-run',
    facts: (async function* () {})(),
    async result() {
      return { outcome: 'completed' as const };
    },
  };

  const useCase = new StartRequestRunUseCase(
    {
      async startRequestRun(input: unknown) {
        providerCalls.push(input);
        return providerRun;
      },
    } as never,
    {
      hasActiveRequestRun() {
        return false;
      },
      registerRequestRun() {
        return { activeRunIds: ['run-active'] };
      },
      ensure(input: { toolSessionId: string; welinkSessionId?: string }) {
        return {
          toolSessionId: input.toolSessionId,
          welinkSessionId: input.welinkSessionId,
          requestRun: { activeRunIds: ['active'] },
          outbound: { status: 'idle' as const },
        };
      },
      releaseRequestRun(toolSessionId: string, runId: string) {
        released.push({ toolSessionId, runId });
      },
    } as never,
    {
      async executeRun(input: unknown) {
        coordinatorCalls.push(input);
      },
    } as never,
    observation as never,
  );

  await useCase.execute(createCommand());

  assert.equal(providerCalls.length, 1);
  const providerInput = providerCalls[0] as {
    traceId: string;
    runId: string;
    toolSessionId: string;
    text: string;
    assistantId?: string;
    extParameters?: unknown;
    context?: unknown;
  };
  assert.equal(providerInput.traceId, 'trace-run');
  assert.equal(providerInput.toolSessionId, 'tool-1');
  assert.equal(providerInput.text, 'hello');
  assert.equal(providerInput.assistantId, 'assistant-1');
  assert.deepEqual(providerInput.extParameters, { channel: 'test' });
  assert.deepEqual(providerInput.context, {
    assistantAccount: 'assistant-account',
    sendUserAccount: 'sender-account',
    suppressReply: true,
  });
  assert.match(providerInput.runId, /^[0-9a-f-]{36}$/u);

  assert.deepEqual(coordinatorCalls, [{
    toolSessionId: 'tool-1',
    welinkSessionId: 'we-1',
    runId: providerInput.runId,
    run: providerRun,
  }]);
  assert.deepEqual(released, [{ toolSessionId: 'tool-1', runId: providerInput.runId }]);
  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseSucceeded']);
});

test('StartRequestRunUseCase rejects active run conflict before provider call', async () => {
  const observation = new RecordingObservation();
  let providerCalled = false;

  const useCase = new StartRequestRunUseCase(
    {
      async startRequestRun() {
        providerCalled = true;
        throw new Error('unexpected');
      },
    } as never,
    {
      hasActiveRequestRun() {
        return true;
      },
    } as never,
    {
      async executeRun() {
        throw new Error('unexpected');
      },
    } as never,
    observation as never,
  );

  await assert.rejects(
    () => useCase.execute(createCommand()),
    (error) => error instanceof RuntimeContractError && error.code === 'run_already_active',
  );

  assert.equal(providerCalled, false);
  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseConflict']);
});

test('StartRequestRunUseCase releases request run when provider throws', async () => {
  const observation = new RecordingObservation();
  const released: Array<{ toolSessionId: string; runId: string }> = [];

  const useCase = new StartRequestRunUseCase(
    {
      async startRequestRun() {
        throw new Error('provider_down');
      },
    } as never,
    {
      hasActiveRequestRun() {
        return false;
      },
      registerRequestRun() {
        return { activeRunIds: ['run-active'] };
      },
      ensure(input: { toolSessionId: string; welinkSessionId?: string }) {
        return {
          toolSessionId: input.toolSessionId,
          welinkSessionId: input.welinkSessionId,
          requestRun: { activeRunIds: ['active'] },
          outbound: { status: 'idle' as const },
        };
      },
      releaseRequestRun(toolSessionId: string, runId: string) {
        released.push({ toolSessionId, runId });
      },
    } as never,
    {
      async executeRun() {
        throw new Error('unexpected');
      },
    } as never,
    observation as never,
  );

  await assert.rejects(() => useCase.execute(createCommand()), /provider_down/);

  assert.equal(released.length, 1);
  assert.equal(released[0]?.toolSessionId, 'tool-1');
  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseFailed']);
});
