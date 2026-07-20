import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DefaultRuntimeObservation,
  type RuntimeObservationEvent,
  type RuntimeObservationPort,
} from '@/application/runtime-observation/index.ts';

class RecordingObservationPort implements RuntimeObservationPort {
  readonly events: RuntimeObservationEvent[] = [];

  record(event: RuntimeObservationEvent): void {
    this.events.push(event);
  }
}

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

test('default runtime observation maps gateway probe events', () => {
  const port = new RecordingObservationPort();
  const observation = new DefaultRuntimeObservation(port);

  observation.gatewayProbeRequested('ws://gateway.local', 50);
  observation.gatewayProbeCompleted('ws://gateway.local', 'connect_error', 12, 'gateway_not_connected');

  assert.deepEqual(port.events, [
    {
      type: 'gateway_probe',
      phase: 'requested',
      gatewayUrl: 'ws://gateway.local',
      timeoutMs: 50,
    },
    {
      type: 'gateway_probe',
      phase: 'completed',
      gatewayUrl: 'ws://gateway.local',
      state: 'connect_error',
      latencyMs: 12,
      reason: 'gateway_not_connected',
    },
  ]);
});

test('observation records request run policy fields in usecase started context', () => {
  const port = new RecordingObservationPort();
  const observation = new DefaultRuntimeObservation(port);

  observation.usecaseStarted('start_request_run', 'trace-run', {
    toolSessionId: 'tool-1',
    runId: 'run-2',
    activeRunChatPolicy: 'forwardToProvider',
    activeRunIds: ['run-1'],
  });

  assert.deepEqual(port.events, [{
    type: 'usecase_progress',
    phase: 'started',
    usecase: 'start_request_run',
    traceId: 'trace-run',
    toolSessionId: 'tool-1',
    runId: 'run-2',
    activeRunChatPolicy: 'forwardToProvider',
    activeRunIds: ['run-1'],
  }]);
});
