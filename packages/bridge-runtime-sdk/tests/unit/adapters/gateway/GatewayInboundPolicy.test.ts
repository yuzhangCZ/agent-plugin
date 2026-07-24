import test from 'node:test';
import assert from 'node:assert/strict';

import type { GatewayInboundFrame } from '@agent-plugin/gateway-client';
import type { ToolErrorMessage } from '@agent-plugin/gateway-schema';

import { GatewayInboundPolicy } from '@/adapters/gateway/GatewayInboundPolicy.ts';
import type { OutboundSink } from '@/application/ports/outbound-sink.ts';
import { ToolErrorMessageCatalog } from '@/application/projectors/ToolErrorMessageCatalog.ts';
import { ToolErrorReporter } from '@/application/reporters/index.ts';
import type { RuntimeObservation } from '@/application/runtime-observation/index.ts';

interface FakeObservation extends RuntimeObservation {
  failureCalls: unknown[];
  rejectedCalls: unknown[];
  uplinkCalls: unknown[];
}

function createFakeObservation(): FakeObservation {
  const obs = {
    failureCalls: [] as unknown[],
    rejectedCalls: [] as unknown[],
    uplinkCalls: [] as unknown[],
  };
  return new Proxy(obs, {
    get(target, prop: string) {
      if (prop === 'failureCalls' || prop === 'rejectedCalls' || prop === 'uplinkCalls') {
        return target[prop];
      }
      if (prop === 'failureRecorded') {
        return (...args: unknown[]) => {
 target.failureCalls.push(args); 
};
      }
      if (prop === 'invalidInvokeRejected') {
        return (...args: unknown[]) => {
 target.rejectedCalls.push(args); 
};
      }
      if (prop === 'uplinkEmitted') {
        return (...args: unknown[]) => {
 target.uplinkCalls.push(args); 
};
      }
      return () => {};
    },
  }) as unknown as FakeObservation;
}

interface FakeSink extends OutboundSink {
  sent: ToolErrorMessage[];
}

function createFakeSink(): FakeSink {
  const sent: ToolErrorMessage[] = [];
  return { sent, send: (message: ToolErrorMessage) => {
 sent.push(message); 
} } as unknown as FakeSink;
}

function createPolicy(observation: RuntimeObservation, sink: OutboundSink): GatewayInboundPolicy {
  const catalog = new ToolErrorMessageCatalog();
  return new GatewayInboundPolicy(
    observation,
    new ToolErrorReporter(sink, observation, catalog),
    catalog,
  );
}

function createInvalidInvokeFrame(
  violation: { code: string; field?: string; action?: string; message: string },
  options: { welinkSessionId?: string; toolSessionId?: string } = {},
): GatewayInboundFrame {
  return {
    kind: 'invalid',
    messageType: 'invoke',
    gatewayMessageId: 'gw-1',
    action: violation.action ?? 'chat',
    welinkSessionId: options.welinkSessionId,
    toolSessionId: options.toolSessionId,
    violation: {
      violation: {
        stage: 'payload',
        code: violation.code,
        field: violation.field ?? 'action',
        message: violation.message,
        messageType: 'invoke',
        action: violation.action,
        welinkSessionId: options.welinkSessionId,
        toolSessionId: options.toolSessionId,
      },
    },
    rawPreview: {},
  } as unknown as GatewayInboundFrame;
}

test('GatewayInboundPolicy sends tool_error with unsupported_action joined by action segment', () => {
  const observation = createFakeObservation();
  const sink = createFakeSink();
  const policy = createPolicy(observation, sink);

  policy.handle(
    createInvalidInvokeFrame(
      { code: 'unsupported_action', action: 'foobar', message: 'Unsupported downstream action: foobar' },
      { welinkSessionId: 'wl-1', toolSessionId: 'tool-1' },
    ),
    { isGatewayReady: true },
  );

  assert.deepEqual(sink.sent, [{
    type: 'tool_error',
    welinkSessionId: 'wl-1',
    toolSessionId: 'tool-1',
    error: '暂不支持该操作类型，请检查版本后重试 (unsupported_action: foobar)',
  }]);
});

test('GatewayInboundPolicy sends tool_error with invalid_field_value joined by field segment', () => {
  const observation = createFakeObservation();
  const sink = createFakeSink();
  const policy = createPolicy(observation, sink);

  policy.handle(
    createInvalidInvokeFrame(
      { code: 'invalid_field_value', field: 'payload.text', message: 'payload.text is required' },
      { welinkSessionId: 'wl-1', toolSessionId: 'tool-1' },
    ),
    { isGatewayReady: true },
  );

  assert.deepEqual(sink.sent, [{
    type: 'tool_error',
    welinkSessionId: 'wl-1',
    toolSessionId: 'tool-1',
    error: '请求格式异常，请稍后重试 (invalid_field_value: payload.text)',
  }]);
});

test('GatewayInboundPolicy sends tool_error with invalid_field_value for type-mismatch field', () => {
  const observation = createFakeObservation();
  const sink = createFakeSink();
  const policy = createPolicy(observation, sink);

  policy.handle(
    createInvalidInvokeFrame(
      { code: 'invalid_field_value', field: 'payload.suppressReply', message: 'payload.suppressReply must be a boolean' },
      { welinkSessionId: 'wl-1', toolSessionId: 'tool-1' },
    ),
    { isGatewayReady: true },
  );

  assert.deepEqual(sink.sent, [{
    type: 'tool_error',
    welinkSessionId: 'wl-1',
    toolSessionId: 'tool-1',
    error: '请求格式异常，请稍后重试 (invalid_field_value: payload.suppressReply)',
  }]);
});

test('GatewayInboundPolicy does not send tool_error when no routable session ids', () => {
  const observation = createFakeObservation();
  const sink = createFakeSink();
  const policy = createPolicy(observation, sink);

  policy.handle(
    createInvalidInvokeFrame(
      { code: 'invalid_field_value', field: 'payload.text', message: 'payload.text is required' },
    ),
    { isGatewayReady: true },
  );

  assert.equal(sink.sent.length, 0);
  assert.equal(observation.failureCalls.length, 1);
  assert.equal(observation.rejectedCalls.length, 0);
});

test('GatewayInboundPolicy does not send tool_error when gateway not ready', () => {
  const observation = createFakeObservation();
  const sink = createFakeSink();
  const policy = createPolicy(observation, sink);

  policy.handle(
    createInvalidInvokeFrame(
      { code: 'unsupported_action', action: 'foobar', message: 'Unsupported downstream action: foobar' },
      { welinkSessionId: 'wl-1', toolSessionId: 'tool-1' },
    ),
    { isGatewayReady: false },
  );

  assert.equal(sink.sent.length, 0);
  assert.equal(observation.failureCalls.length, 1);
  assert.equal(observation.rejectedCalls.length, 0);
  assert.equal(observation.uplinkCalls.length, 0);
});

test('GatewayInboundPolicy ignores invalid frames that are not invoke', () => {
  const observation = createFakeObservation();
  const sink = createFakeSink();
  const policy = createPolicy(observation, sink);

  const nonInvokeFrame = {
    kind: 'invalid',
    messageType: 'unsupported_type',
    violation: { violation: { code: 'unsupported_message', field: 'type', message: 'unsupported' } },
  } as unknown as GatewayInboundFrame;

  policy.handle(nonInvokeFrame, { isGatewayReady: true });

  assert.equal(sink.sent.length, 0);
  assert.equal(observation.failureCalls.length, 0);
});
