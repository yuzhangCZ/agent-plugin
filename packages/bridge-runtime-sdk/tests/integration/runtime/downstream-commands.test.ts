import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeRuntime } from '@/index.ts';
import { createFakeRun, createProvider, createRuntimeOptions, FakeGatewayClient, flushEvents } from '../support/runtime-harness.ts';

function createInvalidInvokeInboundFrame() {
  return {
    kind: 'invalid',
    messageType: 'invoke',
    gatewayMessageId: 'gw-invalid-1',
    action: 'chat',
    welinkSessionId: 'wl-invalid-1',
    toolSessionId: 'tool-invalid-1',
    violation: {
      violation: {
        stage: 'payload',
        code: 'invalid_field_value',
        field: 'payload.text',
        message: 'payload.text is required',
        messageType: 'invoke',
        action: 'chat',
        welinkSessionId: 'wl-invalid-1',
        toolSessionId: 'tool-invalid-1',
      },
    },
    rawPreview: {
      type: 'invoke',
      messageId: 'gw-invalid-1',
      action: 'chat',
      welinkSessionId: 'wl-invalid-1',
      payload: {
        toolSessionId: 'tool-invalid-1',
      },
    },
  };
}

test('runtime responds to status_query with provider health status', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(createRuntimeOptions(createProvider(), connection));

  await runtime.start();
  connection.emitMessage({
    type: 'status_query',
    welinkSessionId: 'welink-status-1',
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'status_response',
    opencodeOnline: true,
  });
});

test('runtime responds to query_slash_commands with provider slash command list', async () => {
  const connection = new FakeGatewayClient();
  let providerInput;
  const provider = createProvider();
  provider.listSlashCommands = async (input) => {
    providerInput = input;
    return {
      slashCommands: [
        { command: '/new', description: '新建会话' },
        { command: '/init', description: '初始化项目' },
        { command: '//slash-init', description: 'slash-prefixed catalog name' },
        { command: '/bad command', description: 'whitespace command' },
        { command: '/foo/bar', description: 'nested command' },
        { command: '', description: 'empty command' },
        { command: '/review', description: `  ${'x'.repeat(60)}  ` },
      ],
    };
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'query_slash_commands',
    toolSessionId: 'tool-slash-1',
    traceId: 'trace-slash-1',
    payload: {
      extParameters: {
        platformExtParam: {
          businessSessionDomain: 'im',
          businessSessionType: 'direct',
          businessSessionId: 'user-a#bot-a',
        },
      },
    },
  });
  await flushEvents();

  assert.deepEqual(providerInput, {
    traceId: 'trace-fixed',
    extParameters: {
      platformExtParam: {
        businessSessionDomain: 'im',
        businessSessionType: 'direct',
        businessSessionId: 'user-a#bot-a',
      },
    },
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'slash_commands_result',
    toolSessionId: 'tool-slash-1',
    traceId: 'trace-slash-1',
    payload: {
      slashCommands: [
        { command: '/new', description: '新建会话' },
        { command: '/init', description: '初始化项目' },
        { command: '/review', description: 'x'.repeat(60) },
      ],
    },
  });
});

test('runtime returns empty slash command list when provider listSlashCommands fails', async () => {
  const connection = new FakeGatewayClient();
  const provider = createProvider();
  provider.listSlashCommands = async () => {
    throw new Error('command list failed');
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'query_slash_commands',
    toolSessionId: 'tool-slash-failed',
    traceId: 'trace-slash-failed',
    payload: {},
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'slash_commands_result',
    toolSessionId: 'tool-slash-failed',
    traceId: 'trace-slash-failed',
    payload: {
      slashCommands: [],
    },
  });
});

test('request-level command failures stay ready and record command_execution_failure', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage() {
          throw new Error('run_failed');
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
        async abortSession() {
          return { applied: true };
        },
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: 'run_failed',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'command_execution_failure',
    phase: 'runtime',
    message: 'run_failed',
    code: undefined,
  });
  assert.equal(runtime.getStatus().failureReason, null);
});

test('create_session command failure projects tool_error without a session route', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          throw new Error('create_session_failed');
        },
        async runMessage() {
          return createFakeRun([], { outcome: 'completed' });
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
        async abortSession() {
          return { applied: true };
        },
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'create_session',
    welinkSessionId: 'welink-create-1',
    payload: { title: 'demo' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    error: 'create_session_failed',
  });
});

test('invalid downstream messages stay ready and record inbound_validation_failure', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage() {
          return createFakeRun([], { outcome: 'completed' });
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
        async abortSession() {
          return { applied: true };
        },
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'unsupported_action',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'inbound_validation_failure',
    phase: 'runtime',
    message: 'Unsupported downstream action: unsupported_action',
    code: undefined,
  });
  assert.equal(runtime.getStatus().failureReason, null);
});

test('runtime handles invalid invoke inbound frames and records transport diagnostics', async () => {
  const connection = new FakeGatewayClient();
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage() {
          return createFakeRun([], { outcome: 'completed' });
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
        async abortSession() {
          return { applied: true };
        },
      },
      connection,
    ),
  );

  await runtime.start();
  connection.emitInbound(createInvalidInvokeInboundFrame());
  connection.emitHeartbeat({ type: 'heartbeat' });
  await flushEvents();

  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_error',
    welinkSessionId: 'wl-invalid-1',
    toolSessionId: 'tool-invalid-1',
    error: '请求格式异常，请稍后重试 (invalid_field_value: payload.text)',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'inbound_validation_failure',
    phase: 'runtime',
    message: 'payload.text is required',
    code: 'invalid_field_value',
  });
  assert.equal(runtime.getDiagnostics().gatewayState, 'ready');
  assert.equal(typeof runtime.getDiagnostics().lastInboundAt, 'number');
  assert.equal(typeof runtime.getDiagnostics().lastOutboundAt, 'number');
  assert.equal(typeof runtime.getDiagnostics().lastHeartbeatAt, 'number');
  assert.equal(runtime.getStatus().failureReason, null);
});
