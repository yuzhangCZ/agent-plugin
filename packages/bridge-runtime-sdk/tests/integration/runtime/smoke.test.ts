import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeRuntime } from '@/index.ts';
import type { ThirdPartyAgentProvider } from '@/index.ts';
import { createFakeRun, createProvider, createRuntimeOptions, FakeGatewayClient, flushEvents } from '../support/runtime-harness.ts';

test('runtime starts, consumes downstream messages from gateway-client, and projects uplinks', async () => {
  const connection = new FakeGatewayClient();
  const provider: ThirdPartyAgentProvider = {
    async health() {
      return { online: true };
    },
    async createSession() {
      return { toolSessionId: 'tool-1' };
    },
    async runMessage() {
      return createFakeRun(
        [
          { type: 'message.start', messageId: 'msg-1' },
          { type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: 'he' },
          { type: 'text.done', messageId: 'msg-1', partId: 'part-1', content: 'hello' },
          { type: 'message.done', messageId: 'msg-1' },
        ],
        { outcome: 'completed' },
      );
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
  };

  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  assert.deepEqual(runtime.getStatus(), {
    state: 'ready',
    failureReason: null,
  });

  connection.emitMessage({
    type: 'invoke',
    action: 'create_session',
    welinkSessionId: 'welink-1',
    payload: { title: 'demo' },
  });
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent[0], {
    type: 'session_created',
    welinkSessionId: 'welink-1',
    toolSessionId: 'tool-1',
    session: { sessionId: 'tool-1' },
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'tool_done',
    toolSessionId: 'tool-1',
  });
  assert.equal(
    connection.sent.some(
      (message) => typeof message === 'object' && message !== null && 'type' in message && message.type === 'tool_event',
    ),
    true,
  );

  await runtime.stop();
  assert.deepEqual(runtime.getStatus(), {
    state: 'idle',
    failureReason: null,
  });
});

test('runtime preserves stream fact content verbatim when projecting uplinks', async () => {
  const connection = new FakeGatewayClient();
  const originalContent = '  keep leading spaces\nand trailing tabs\t';
  const toolContent = {
    title: '  Run command\t',
    input: { command: 'ls -la' },
    output: '',
    error: '\nfailed\t',
  };
  const provider: ThirdPartyAgentProvider = {
    ...createProvider(),
    async runMessage() {
      return createFakeRun(
        [
          { type: 'message.start', messageId: 'msg-1' },
          { type: 'text.delta', messageId: 'msg-1', partId: 'part-1', content: originalContent },
          {
            type: 'tool.update',
            messageId: 'msg-1',
            partId: 'part-tool-1',
            toolCallId: 'tool-call-1',
            toolName: 'bash',
            status: 'error',
            ...toolContent,
          },
          { type: 'message.done', messageId: 'msg-1' },
        ],
        { outcome: 'completed' },
      );
    },
  };
  const runtime = await createBridgeRuntime(createRuntimeOptions(provider, connection));

  await runtime.start();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-1',
    payload: { toolSessionId: 'tool-1', text: 'hi' },
  });
  await flushEvents();

  assert.deepEqual(connection.sent[1], {
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      protocol: 'cloud',
      type: 'text.delta',
      properties: { messageId: 'msg-1', partId: 'part-1', content: originalContent, extParameters: undefined },
    },
  });
  assert.deepEqual(connection.sent[2], {
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      protocol: 'cloud',
      type: 'tool.update',
      properties: {
        messageId: 'msg-1',
        partId: 'part-tool-1',
        toolCallId: 'tool-call-1',
        toolName: 'bash',
        status: 'error',
        ...toolContent,
        extParameters: undefined,
      },
    },
  });
});
