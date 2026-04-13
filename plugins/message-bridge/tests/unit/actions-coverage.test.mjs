import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatAction } from '../../src/action/ChatAction.ts';
import { CreateSessionAction } from '../../src/action/CreateSessionAction.ts';
import { CloseSessionAction } from '../../src/action/CloseSessionAction.ts';
import { PermissionReplyAction } from '../../src/action/PermissionReplyAction.ts';
import { StatusQueryAction } from '../../src/action/StatusQueryAction.ts';
import { AbortSessionAction } from '../../src/action/AbortSessionAction.ts';
import { QuestionReplyAction } from '../../src/action/QuestionReplyAction.ts';
import { toHostClientLike } from '../../src/runtime/SdkAdapter.ts';

function readyContext(client, overrides = {}) {
  return {
    client,
    hostClient: overrides.hostClient ?? client,
    connectionState: 'READY',
    sessionId: 'ctx-session',
    effectiveDirectory: overrides.effectiveDirectory,
    ...overrides,
  };
}

function createLoggerRecorder() {
  const calls = [];
  const logger = {
    debug: (message, extra) => calls.push({ level: 'debug', message, extra }),
    info: (message, extra) => calls.push({ level: 'info', message, extra }),
    warn: (message, extra) => calls.push({ level: 'warn', message, extra }),
    error: (message, extra) => calls.push({ level: 'error', message, extra }),
    child: () => logger,
    getTraceId: () => 'test-trace-id',
  };

  return { calls, logger };
}

function createChatAction(overrides = {}) {
  return new ChatAction({
    execute: async (input) => {
      if (overrides.execute) {
        return overrides.execute(input);
      }
      return { success: true };
    },
  });
}

describe('ChatAction coverage', () => {
  test('execute delegates to chat use case with expected payload shape', async () => {
    const calls = [];
    const action = createChatAction({
      execute: async (input) => {
        calls.push(input);
        return { success: true };
      },
    });
    const result = await action.execute({ toolSessionId: 's-1', text: 'hi' }, readyContext({}));
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls[0], {
      payload: { toolSessionId: 's-1', text: 'hi' },
      logger: undefined,
    });
  });

  test('does not read effectiveDirectory when delegating chat', async () => {
    const calls = [];
    const action = createChatAction({
      execute: async (input) => {
        calls.push(input);
        return { success: true };
      },
    });

    const result = await action.execute({ toolSessionId: 's-2', text: 'hello' }, readyContext({}, {
      effectiveDirectory: '/tmp/bridge-dir',
    }));
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls[0], {
      payload: { toolSessionId: 's-2', text: 'hello' },
      logger: undefined,
    });
  });

  test('forwards assistantId through chat use case payload', async () => {
    const calls = [];
    const action = createChatAction({
      execute: async (input) => {
        calls.push(input);
        return { success: true };
      },
    });

    const result = await action.execute(
      { toolSessionId: 's-3', text: 'hello agent', assistantId: 'persona-1' },
      readyContext({}, {
        effectiveDirectory: '/tmp/bridge-dir',
      }),
    );
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls[0], {
      payload: { toolSessionId: 's-3', text: 'hello agent', assistantId: 'persona-1' },
      logger: undefined,
    });
  });

  test('execute handles use case failure result', async () => {
    const action = createChatAction({
      execute: async () => ({ success: false, errorCode: 'SDK_UNREACHABLE', errorMessage: 'boom' }),
    });
    const result = await action.execute({ toolSessionId: 's-1', text: 'hi' }, readyContext({}));
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorCode, 'SDK_UNREACHABLE');
    assert.ok(result.errorMessage.includes('boom'));
  });

  test('execute handles rejected and thrown use case errors', async () => {
    const rejectAction = createChatAction({
      execute: async () => {
        throw new Error('transport down');
      },
    });
    const rejectResult = await rejectAction.execute({ toolSessionId: 's-1', text: 'hi' }, readyContext({}));
    assert.strictEqual(rejectResult.success, false);
    assert.strictEqual(rejectResult.errorCode, 'SDK_UNREACHABLE');
    assert.ok(rejectResult.errorMessage.includes('transport down'));

    const throwAction = createChatAction({
      execute: () => {
        throw new Error('timeout now');
      },
    });
    const throwResult = await throwAction.execute({ toolSessionId: 's-1', text: 'hi' }, readyContext({}));
    assert.strictEqual(throwResult.success, false);
    assert.strictEqual(throwResult.errorCode, 'SDK_TIMEOUT');
  });

  test('errorMapper variants', () => {
    const action = createChatAction();
    assert.strictEqual(action.errorMapper(new Error('connection refused')), 'SDK_UNREACHABLE');
    assert.strictEqual(action.errorMapper(new Error('session not found')), 'INVALID_PAYLOAD');
    assert.strictEqual(action.errorMapper('timeout'), 'SDK_TIMEOUT');
  });
});

describe('CreateSessionAction coverage', () => {
  test('execute success with returned sessionId', async () => {
    const action = new CreateSessionAction();
    const calls = [];
    const client = {
      session: {
        create: async (options) => {
          calls.push(options);
          return { data: { id: 'new-1' } };
        },
        abort: async () => ({}),
        prompt: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
    };
    const result = await action.execute({ title: 'Session X' }, readyContext(client));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.sessionId, 'new-1');
    assert.deepStrictEqual(calls[0], { title: 'Session X' });
  });

  test('attaches effectiveDirectory to create_session parameters', async () => {
    const action = new CreateSessionAction();
    const calls = [];
    const client = {
      session: {
        create: async (options) => {
          calls.push(options);
          return { data: { id: 'new-2' } };
        },
        abort: async () => ({}),
        prompt: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
    };

    const result = await action.execute({ title: 'With directory' }, readyContext(client, {
      effectiveDirectory: '/tmp/bridge-dir',
    }));
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls[0], {
      title: 'With directory',
      directory: '/tmp/bridge-dir',
    });
  });

  test('logs resolved directory from use case before create_session starts', async () => {
    const { calls, logger } = createLoggerRecorder();
    const action = new CreateSessionAction({
      resolveCreateSession: async () => ({
        directory: '/mapped/worktree',
        source: 'mapping',
        resolvedDirectory: '/mapped/worktree',
        resolvedDirectorySource: 'mapping',
      }),
      execute: async () => ({
        success: true,
        data: {
          sessionId: 'new-3',
          session: { sessionId: 'new-3' },
        },
      }),
    });

    const result = await action.execute(
      { title: 'Mapped Session', assistantId: 'persona-1' },
      readyContext({ session: {}, postSessionIdPermissionsPermissionId: async () => ({}) }, { logger }),
    );

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(
      calls.filter((call) => call.message === 'action.create_session.started').map((call) => call.extra),
      [
        {
          payloadKeys: ['title', 'assistantId'],
          resolvedDirectory: '/mapped/worktree',
          resolvedDirectorySource: 'mapping',
        },
      ],
    );
  });

  test('logs none as resolved directory source when fallback create_session has no directory', async () => {
    const { calls, logger } = createLoggerRecorder();
    const action = new CreateSessionAction();
    const client = {
      session: {
        create: async () => ({ data: { id: 'new-4' } }),
        abort: async () => ({}),
        prompt: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
    };

    const result = await action.execute({ title: 'No directory' }, readyContext(client, { logger }));

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(
      calls.filter((call) => call.message === 'action.create_session.started').map((call) => call.extra),
      [
        {
          payloadKeys: ['title'],
          resolvedDirectory: undefined,
          resolvedDirectorySource: 'none',
        },
      ],
    );
  });

  test('execute handles sdk failures', async () => {
    const action = new CreateSessionAction();
    const client = {
      session: {
        create: async () => ({ error: { message: 'blocked' } }),
        abort: async () => ({}),
        prompt: async () => ({}),
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
    };
    const failed = await action.execute({}, readyContext(client));
    assert.strictEqual(failed.success, false);
    assert.ok(failed.errorMessage.includes('blocked'));
  });
});

describe('CloseSessionAction coverage', () => {
  test('execute delegates close_session to session-scoped gateway', async () => {
    const calls = [];
    const action = new CloseSessionAction({
      closeSession: async (options) => {
        calls.push(options);
        return { success: true, data: { sessionId: 's1', closed: true } };
      },
    });
    const ok = await action.execute({ toolSessionId: 's1' }, readyContext({}));
    assert.strictEqual(ok.success, true);
    assert.strictEqual(ok.data.closed, true);
    assert.deepStrictEqual(calls[0], { sessionId: 's1' });
  });

  test('does not read effectiveDirectory when delegating close_session', async () => {
    const calls = [];
    const action = new CloseSessionAction({
      closeSession: async (options) => {
        calls.push(options);
        return { success: true, data: { sessionId: 's2', closed: true } };
      },
    });

    const result = await action.execute({ toolSessionId: 's2' }, readyContext({}, {
      effectiveDirectory: '/tmp/bridge-dir',
    }));
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls[0], { sessionId: 's2' });
  });
});

describe('PermissionReplyAction coverage', () => {
  test('execute delegates permission_reply to session-scoped gateway', async () => {
    const calls = [];
    const action = new PermissionReplyAction({
      replyPermission: async (options) => {
        calls.push(options);
        return {
          success: true,
          data: { permissionId: 'p1', response: 'once', applied: true },
        };
      },
    });

    const allow = await action.execute(
      { permissionId: 'p1', toolSessionId: 's-tool', response: 'once' },
      readyContext({}),
    );

    assert.strictEqual(allow.success, true);
    assert.deepStrictEqual(calls[0], {
      sessionId: 's-tool',
      permissionId: 'p1',
      response: 'once',
    });
  });

  test('does not read effectiveDirectory when delegating permission_reply', async () => {
    const calls = [];
    const action = new PermissionReplyAction({
      replyPermission: async (options) => {
        calls.push(options);
        return {
          success: true,
          data: { permissionId: 'p2', response: 'reject', applied: true },
        };
      },
    });

    const result = await action.execute(
      { permissionId: 'p2', toolSessionId: 's-tool-2', response: 'reject' },
      readyContext({}, {
        effectiveDirectory: '/tmp/bridge-dir',
      }),
    );

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls[0], {
      sessionId: 's-tool-2',
      permissionId: 'p2',
      response: 'reject',
    });
  });
});

describe('StatusQueryAction coverage', () => {
  test('execute uses global.health when available and raw health fallback otherwise', async () => {
    const action = new StatusQueryAction();
    const ready = await action.execute({}, readyContext({
      global: {
        health: async () => ({ healthy: true, version: '9.9.9' }),
      },
      _client: {
        get: async () => {
          throw new Error('raw fallback should not be called');
        },
      },
    }));
    assert.strictEqual(ready.success, true);
    assert.strictEqual(ready.data.opencodeOnline, true);

    const readyViaRawFallback = await action.execute({}, readyContext({
      _client: {
        get: async (options) => {
          assert.deepStrictEqual(options, { url: '/global/health' });
          return { data: { healthy: true, version: '9.9.9' } };
        },
      },
    }, {
      hostClient: toHostClientLike({
        _client: {
          get: async (options) => {
            assert.deepStrictEqual(options, { url: '/global/health' });
            return { data: { healthy: true, version: '9.9.9' } };
          },
        },
      }),
    }));
    assert.strictEqual(readyViaRawFallback.success, true);
    assert.strictEqual(readyViaRawFallback.data.opencodeOnline, true);

    const downViaHealthFalse = await action.execute({}, readyContext({
      global: {
        health: async () => ({ healthy: false, version: '9.9.9' }),
      },
    }));
    assert.strictEqual(downViaHealthFalse.success, true);
    assert.strictEqual(downViaHealthFalse.data.opencodeOnline, false);

    const downViaRawError = await action.execute({}, readyContext({
      _client: {
        get: async () => ({ error: { message: 'bad gateway' } }),
      },
    }, {
      hostClient: toHostClientLike({
        _client: {
          get: async () => ({ error: { message: 'bad gateway' } }),
        },
      }),
    }));
    assert.strictEqual(downViaRawError.success, true);
    assert.strictEqual(downViaRawError.data.opencodeOnline, false);

    const down = await action.execute(
      {},
      readyContext({
        _client: {
          get: async () => {
            throw new Error('global unavailable');
          },
        },
      }, {
        connectionState: 'READY',
        hostClient: toHostClientLike({
          _client: {
            get: async () => {
              throw new Error('global unavailable');
            },
          },
        }),
      }),
    );
    assert.strictEqual(down.success, true);
    assert.strictEqual(down.data.opencodeOnline, false);
  });
});

describe('AbortSessionAction coverage', () => {
  test('execute delegates abort_session to session-scoped gateway', async () => {
    const calls = [];
    const action = new AbortSessionAction({
      abortSession: async (options) => {
        calls.push(options);
        return { success: true, data: { sessionId: 'abort-1', aborted: true } };
      },
    });

    const result = await action.execute({ toolSessionId: 'abort-1' }, readyContext({}));
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, { sessionId: 'abort-1', aborted: true });
    assert.deepStrictEqual(calls[0], { sessionId: 'abort-1' });
  });

  test('does not read effectiveDirectory when delegating abort_session', async () => {
    const calls = [];
    const action = new AbortSessionAction({
      abortSession: async (options) => {
        calls.push(options);
        return { success: true, data: { sessionId: 'abort-2', aborted: true } };
      },
    });

    const result = await action.execute({ toolSessionId: 'abort-2' }, readyContext({}, {
      effectiveDirectory: '/tmp/bridge-dir',
    }));
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls[0], { sessionId: 'abort-2' });
  });
});

describe('QuestionReplyAction coverage', () => {
  test('execute delegates question_reply to session-scoped gateway', async () => {
    const calls = [];
    const action = new QuestionReplyAction({
      replyQuestion: async (options) => {
        calls.push(options);
        return { success: true, data: { requestId: 'req-1', replied: true } };
      },
    });

    const result = await action.execute(
      { toolSessionId: 'tool-9', toolCallId: 'call-1', answer: 'answer' },
      readyContext({}),
    );

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, { requestId: 'req-1', replied: true });
    assert.deepStrictEqual(calls, [
      {
        sessionId: 'tool-9',
        toolCallId: 'call-1',
        answer: 'answer',
      },
    ]);
  });

  test('does not read effectiveDirectory when delegating question_reply', async () => {
    const calls = [];
    const action = new QuestionReplyAction({
      replyQuestion: async (options) => {
        calls.push(options);
        return { success: true, data: { requestId: 'req-2', replied: true } };
      },
    });

    const result = await action.execute(
      { toolSessionId: 'tool-10', toolCallId: 'call-2', answer: 'go' },
      readyContext({}, {
        effectiveDirectory: '/tmp/bridge-dir',
      }),
    );

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(calls, [
      {
        sessionId: 'tool-10',
        toolCallId: 'call-2',
        answer: 'go',
      },
    ]);
  });
});
