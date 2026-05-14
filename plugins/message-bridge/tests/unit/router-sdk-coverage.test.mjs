import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultActionRouter } from '../../src/action/ActionRouter.ts';
import { DefaultActionRegistry } from '../../src/action/ActionRegistry.ts';
import { createSdkAdapter, getMissingSdkCapabilities } from '../../src/runtime/SdkAdapter.ts';

describe('DefaultActionRouter coverage', () => {
  const context = {
    client: {},
    connectionState: 'READY',
    sessionId: 's1',
  };

  test('returns error when registry missing', async () => {
    const router = new DefaultActionRouter();
    const result = await router.route('chat', {}, context);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorCode, 'SDK_UNREACHABLE');
  });

  test('returns unsupported action when action not found', async () => {
    const router = new DefaultActionRouter();
    router.setRegistry(new DefaultActionRegistry());
    const result = await router.route('not_exists', {}, context);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorCode, 'UNSUPPORTED_ACTION');
  });

  test('executes registered action with typed payload routing', async () => {
    const router = new DefaultActionRouter();
    const registry = new DefaultActionRegistry();
    registry.register({
      name: 'x',
      execute: async () => ({ success: true, data: { id: 'static-id' } }),
    });
    router.setRegistry(registry);

    const ok = await router.route('x', { p: 1 }, context);
    assert.strictEqual(ok.success, true);
    assert.strictEqual(ok.data.id, 'static-id');
  });
});

describe('createSdkAdapter coverage', () => {
  test('reports missing capabilities in fixed order', () => {
    assert.deepStrictEqual(getMissingSdkCapabilities({
      session: {
        create: async () => ({}),
      },
    }), [
      'session.get',
      'session.list',
      'session.prompt',
      'session.abort',
      'session.delete',
      'config.providers',
      'postSessionIdPermissionsPermissionId',
      '_client.post',
    ]);
  });

  test('returns null for invalid or incomplete clients', () => {
    assert.strictEqual(createSdkAdapter(null), null);
    assert.strictEqual(createSdkAdapter({ session: {} }), null);
  });

  test('creates adapted sdk methods and forwards calls', async () => {
    const calls = { create: 0, sessionGet: 0, sessionList: 0, abort: 0, delete: 0, prompt: 0, providers: 0, permission: 0, post: 0 };
    const raw = {
      session: {
        create: async (options) => {
          calls.create += 1;
          return { data: options };
        },
        get: async (options) => {
          calls.sessionGet += 1;
          return { data: options };
        },
        list: async (options) => {
          calls.sessionList += 1;
          return { data: options };
        },
        abort: async (options) => {
          calls.abort += 1;
          return { data: options };
        },
        delete: async (options) => {
          calls.delete += 1;
          return { data: options };
        },
        prompt: async (options) => {
          calls.prompt += 1;
          return { data: options };
        },
      },
      config: {
        providers: async (options) => {
          calls.providers += 1;
          return { data: options };
        },
      },
      postSessionIdPermissionsPermissionId: async (options) => {
        calls.permission += 1;
        return { data: options };
      },
      _client: {
        post: async (options) => {
          calls.post += 1;
          return { data: options };
        },
      },
    };

    const adapted = createSdkAdapter(raw);
    const r1 = await adapted.session.create({ title: 'session-1', directory: '/tmp/bridge' });
    const r2 = await adapted.session.get({ sessionID: 's1', directory: '/tmp/bridge' });
    const r2b = await adapted.session.list({ directory: '/tmp/bridge' });
    const r3 = await adapted.session.abort({ sessionID: 's1', directory: '/tmp/bridge' });
    const r4 = await adapted.session.delete({ sessionID: 's1', directory: '/tmp/bridge' });
    const r5 = await adapted.session.prompt({
      sessionID: 's1',
      directory: '/tmp/bridge',
      parts: [{ type: 'text', text: 'hi' }],
    });
    const r6 = await adapted.config.providers({ directory: '/tmp/bridge' });
    const r7 = await adapted.permission.reply({ permissionId: 'perm-1', response: 'always' });
    const r8 = await adapted.question.reply({ questionId: 'question-1', answer: 'yes' });

    assert.deepStrictEqual(calls, { create: 1, sessionGet: 1, sessionList: 1, abort: 1, delete: 1, prompt: 1, providers: 1, permission: 1, post: 1 });
    assert.deepStrictEqual(r1.data, {
      body: { title: 'session-1' },
      query: { directory: '/tmp/bridge' },
    });
    assert.deepStrictEqual(r2.data, {
      path: { id: 's1' },
      query: { directory: '/tmp/bridge' },
    });
    assert.deepStrictEqual(r3.data, {
      path: { id: 's1' },
      query: { directory: '/tmp/bridge' },
    });
    assert.deepStrictEqual(r2b.data, {
      query: { directory: '/tmp/bridge' },
    });
    assert.deepStrictEqual(r4.data, {
      path: { id: 's1' },
      query: { directory: '/tmp/bridge' },
    });
    assert.deepStrictEqual(r5.data, {
      path: { id: 's1' },
      query: { directory: '/tmp/bridge' },
      body: { parts: [{ type: 'text', text: 'hi' }] },
    });
    assert.deepStrictEqual(r6.data, {
      query: { directory: '/tmp/bridge' },
    });
    assert.deepStrictEqual(r7.data, {
      url: '/session/{id}/permissions/{permissionID}',
      path: { id: '__bridge_permission_compat__', permissionID: 'perm-1' },
      body: { response: 'always' },
      headers: { 'Content-Type': 'application/json' },
    });
    assert.deepStrictEqual(r8.data, {
      url: '/question/{requestID}/reply',
      path: { requestID: 'question-1' },
      body: { answers: [['yes']] },
      headers: { 'Content-Type': 'application/json' },
    });
  });

  test('permission reply facade does not require business code to provide sessionId', async () => {
    const permissionCalls = [];
    const adapted = createSdkAdapter({
      session: {
        create: async () => ({}),
        get: async () => ({}),
        list: async () => ({}),
        prompt: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
      },
      config: {
        providers: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async (options) => {
        permissionCalls.push(options);
        return { data: true };
      },
      _client: {
        post: async () => ({ data: true }),
      },
    });

    await adapted.permission.reply({ permissionId: 'perm-contract-1', response: 'reject' });

    assert.deepStrictEqual(permissionCalls, [
      {
        url: '/session/{id}/permissions/{permissionID}',
        path: { id: '__bridge_permission_compat__', permissionID: 'perm-contract-1' },
        body: { response: 'reject' },
        headers: { 'Content-Type': 'application/json' },
      },
    ]);
  });
});
