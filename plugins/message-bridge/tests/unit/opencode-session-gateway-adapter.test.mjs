import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { OpencodeSessionGatewayAdapter } from '../../src/adapter/OpencodeSessionGatewayAdapter.ts';

describe('OpencodeSessionGatewayAdapter.promptSession', () => {
  test('returns session_not_found evidence when session.get reports NotFoundError', async () => {
    const calls = { get: 0, prompt: 0 };
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => {
          calls.get += 1;
          return {
            error: {
              name: 'NotFoundError',
              data: { message: 'Session not found: ses-missing' },
            },
          };
        },
        prompt: async () => {
          calls.prompt += 1;
          return {};
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-missing',
      text: 'hello',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorEvidence?.sourceErrorCode, 'session_not_found');
    assert.strictEqual(calls.get, 1);
    assert.strictEqual(calls.prompt, 0);
  });

  test('continues prompt when session.get error is not NotFoundError', async () => {
    const calls = { get: 0, prompt: 0 };
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => {
          calls.get += 1;
          return {
            error: {
              name: 'UnknownError',
              data: { message: 'temporary failure' },
            },
          };
        },
        prompt: async () => {
          calls.prompt += 1;
          return {};
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-any',
      text: 'hello',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(calls.get, 1);
    assert.strictEqual(calls.prompt, 1);
  });

  test('returns session_not_found evidence when session.get throws NotFoundError', async () => {
    const calls = { get: 0, prompt: 0 };
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        get: async () => {
          calls.get += 1;
          throw {
            name: 'NotFoundError',
            data: { message: 'Session not found: ses-throw' },
          };
        },
        prompt: async () => {
          calls.prompt += 1;
          return {};
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-throw',
      text: 'hello',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorEvidence?.sourceErrorCode, 'session_not_found');
    assert.strictEqual(calls.get, 1);
    assert.strictEqual(calls.prompt, 0);
  });

  test('keeps old behavior when session.get capability is unavailable', async () => {
    const calls = { prompt: 0 };
    const adapter = new OpencodeSessionGatewayAdapter(() => ({
      session: {
        create: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        prompt: async () => {
          calls.prompt += 1;
          return {};
        },
      },
      postSessionIdPermissionsPermissionId: async () => ({}),
      _client: {
        get: async () => ({}),
        post: async () => ({}),
      },
    }));

    const result = await adapter.promptSession({
      sessionId: 'ses-any',
      text: 'hello',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(calls.prompt, 1);
  });
});
