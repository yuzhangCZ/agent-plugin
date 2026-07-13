import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeTraceCollectorAdapter } from '@/adapters/observation/runtime-trace-observation.ts';
import { CompositeRuntimeObservationPort } from '@/application/runtime-observation/index.ts';

test('trace observation adapter keeps diagnostics in sync with observation events', () => {
  const trace = new RuntimeTraceCollectorAdapter();
  const observation = new CompositeRuntimeObservationPort([trace]);

  observation.record({
    type: 'gateway_state_changed',
    state: 'ready',
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
    type: 'provider_call',
    phase: 'started',
    command: 'abortExecution',
    toolSessionId: 'tool-1',
    runIds: ['run-1', 'run-2'],
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
  assert.equal(diagnostics.gatewayState, 'ready');
  assert.equal(diagnostics.lastReadyAt, 123);
  assert.equal(diagnostics.lastInboundAt, 456);
  assert.deepEqual(diagnostics.providerCalls[0], {
    command: 'createSession',
    toolSessionId: 'tool-1',
  });
  assert.deepEqual(diagnostics.providerCalls[1], {
    command: 'abortExecution',
    toolSessionId: 'tool-1',
    runIds: ['run-1', 'run-2'],
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
