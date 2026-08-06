import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeRuntime } from '@/index.ts';
import { createFakeRun, createRuntimeOptions, FakeGatewayClient, flushEvents } from '../support/runtime-harness.ts';

test('permission.reply and session.title facts project to gateway tool_event uplinks', async () => {
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
          return createFakeRun(
            [
              {
                type: 'permission.ask',
                permissionId: 'permission-1',
                partId: 'part-1',
                messageId: 'msg-1',
                permType: 'file_write',
              },
              {
                type: 'permission.reply',
                permissionId: 'permission-1',
                response: 'once',
                permType: 'file_write',
              },
              {
                type: 'session.title',
                title: 'Updated Title',
              },
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

  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'permission.reply',
        properties: {
          permissionId: 'permission-1',
          response: 'once',
          permType: 'file_write',
          messageId: 'msg-1',
          partId: 'part-1',
        },
      },
    })),
    true,
  );
  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'session.title',
        properties: {
          title: 'Updated Title',
        },
      },
    })),
    true,
  );
});

test('permission.reply without ask presentation context does not emit permission reply tool_event', async () => {
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
          return createFakeRun(
            [
              {
                type: 'permission.reply',
                permissionId: 'permission-missing-1',
                response: 'once',
                permType: 'file_write',
              },
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

  assert.equal(
    connection.sent.some((message) =>
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'tool_event'
      && 'event' in message
      && typeof message.event === 'object'
      && message.event !== null
      && 'type' in message.event
      && message.event.type === 'permission.reply'),
    false,
  );
});

test('permission.ask projects independent partId and permissionId only', async () => {
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
          return createFakeRun(
            [
              { type: 'message.start', messageId: 'msg-1' },
              {
                type: 'permission.ask',
                messageId: 'msg-1',
                partId: 'part-permission-1',
                permissionId: 'permission-1',
                permType: 'file_write',
                title: 'Allow file write',
              },
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

  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'permission.ask',
        properties: {
          messageId: 'msg-1',
          partId: 'part-permission-1',
          permissionId: 'permission-1',
          permType: 'file_write',
          title: 'Allow file write',
        },
      },
    })),
    true,
  );
});

test('permission.ask remains valid without messageId and still registers reply target', async () => {
  const connection = new FakeGatewayClient();
  let replyCount = 0;
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
          return createFakeRun(
            [
              {
                type: 'permission.ask',
                partId: 'permission-1',
                permissionId: 'permission-1',
                permType: 'file_write',
                title: 'Allow file write',
              },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission() {
          replyCount += 1;
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

  assert.equal(
    connection.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: 'tool_event',
      toolSessionId: 'tool-1',
      event: {
        protocol: 'cloud',
        type: 'permission.ask',
        properties: {
          partId: 'permission-1',
          permissionId: 'permission-1',
          permType: 'file_write',
          title: 'Allow file write',
        },
      },
    })),
    true,
  );

  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-1', response: 'once' },
  });
  await flushEvents();

  assert.equal(replyCount, 1);
  assert.equal(runtime.getStatus().state, 'ready');
});

test('permission.ask preserves empty title during projection', async () => {
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
          return createFakeRun(
            [
              {
                type: 'permission.ask',
                partId: 'permission-empty-title',
                permissionId: 'permission-empty-title',
                permType: 'file_write',
                title: '',
              },
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

  const permissionEvent = connection.sent.find((message) => message.type === 'tool_event' && message.event?.type === 'permission.ask');
  assert.ok(permissionEvent);
  assert.deepStrictEqual(permissionEvent, {
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      protocol: 'cloud',
      type: 'permission.ask',
      properties: {
        partId: 'permission-empty-title',
        permissionId: 'permission-empty-title',
        permType: 'file_write',
        title: '',
        extParameters: undefined,
      },
    },
  });
});

test('permission.ask defaults missing title to empty string during projection', async () => {
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
          return createFakeRun(
            [
              {
                type: 'permission.ask',
                partId: 'permission-missing-title',
                permissionId: 'permission-missing-title',
                permType: 'file_write',
              },
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

  const permissionEvent = connection.sent.find((message) => message.type === 'tool_event' && message.event?.type === 'permission.ask');
  assert.ok(permissionEvent);
  assert.deepStrictEqual(permissionEvent, {
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      protocol: 'cloud',
      type: 'permission.ask',
      properties: {
        partId: 'permission-missing-title',
        permissionId: 'permission-missing-title',
        permType: 'file_write',
        title: '',
        extParameters: undefined,
      },
    },
  });
});

test('permission.ask rejects globally duplicated permissionId across sessions without clearing pending interactions', async () => {
  const connection = new FakeGatewayClient();
  const repliedPermissionIds: string[] = [];
  const runtime = await createBridgeRuntime(
    createRuntimeOptions(
      {
        async health() {
          return { online: true };
        },
        async createSession() {
          return { toolSessionId: 'tool-1' };
        },
        async runMessage(input) {
          if (input.toolSessionId === 'tool-1') {
            return createFakeRun(
              [
                { type: 'message.start', messageId: 'msg-1' },
                {
                  type: 'permission.ask',
                  messageId: 'msg-1',
                  partId: 'part-permission-1',
                  permissionId: 'permission-dup',
                  permType: 'file_write',
                },
                { type: 'message.done', messageId: 'msg-1' },
              ],
              { outcome: 'completed' },
            );
          }
          return createFakeRun(
            [
              { type: 'message.start', messageId: 'msg-2' },
              {
                type: 'permission.ask',
                messageId: 'msg-2',
                partId: 'part-permission-current',
                permissionId: 'permission-current',
                permType: 'file_write',
              },
              {
                type: 'permission.ask',
                messageId: 'msg-2',
                partId: 'part-permission-2',
                permissionId: 'permission-dup',
                permType: 'file_write',
              },
              { type: 'message.done', messageId: 'msg-2' },
            ],
            { outcome: 'completed' },
          );
        },
        async replyQuestion() {
          return { applied: true };
        },
        async replyPermission(input) {
          repliedPermissionIds.push(input.permissionId);
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
    payload: { toolSessionId: 'tool-1', text: 'first' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'chat',
    welinkSessionId: 'welink-2',
    payload: { toolSessionId: 'tool-2', text: 'second' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-dup', response: 'once' },
  });
  await flushEvents();
  connection.emitMessage({
    type: 'invoke',
    action: 'permission_reply',
    payload: { permissionId: 'permission-current', response: 'always' },
  });
  await flushEvents();

  assert.deepEqual(repliedPermissionIds, ['permission-dup', 'permission-current']);
  assert.equal(runtime.getStatus().state, 'ready');
  assert.deepEqual(connection.sent.findLast((message) => {
    return typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'tool_error'
      && 'toolSessionId' in message
      && message.toolSessionId === 'tool-2';
  }), {
    type: 'tool_error',
    toolSessionId: 'tool-2',
    error: '当前请求处理失败，请重试',
  });
  assert.deepEqual(runtime.getDiagnostics().failures.at(-1), {
    kind: 'outbound_validation_failure',
    phase: 'runtime',
    message: 'permission interaction reply target must be globally unique',
    code: 'pending_interaction_conflict',
  });
});
