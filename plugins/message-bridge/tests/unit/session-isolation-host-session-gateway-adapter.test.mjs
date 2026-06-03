import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { LegacyHostSessionGatewayAdapter } from '../../src/adapter/session-isolation/host/index.ts';

function createAdapter(overrides = {}) {
  const calls = [];
  const adapter = new LegacyHostSessionGatewayAdapter({
    hostSessionQueryPort: {
      getSession: async (sessionId) => {
        calls.push({ method: 'getSession', sessionId });
        return { id: sessionId, directory: '/repo' };
      },
      listSessions: async (query) => {
        calls.push({ method: 'listSessions', query });
        return [{ id: 'ses-1', directory: query.directory }];
      },
      ...overrides.hostSessionQueryPort,
    },
    sessionCreationPort: {
      createSession: async (input) => {
        calls.push({ method: 'createSession', input });
        return {
          success: true,
          data: { sessionId: 'ses-created', session: { id: 'ses-created', title: input.title } },
        };
      },
      ...overrides.sessionCreationPort,
    },
    sessionScopedActionGatewayPort: {
      promptSession: async (input) => {
        calls.push({ method: 'promptSession', input });
        return { success: true, data: { prompted: true } };
      },
      closeSession: async (input) => {
        calls.push({ method: 'closeSession', input });
        return { success: true, data: { closed: true } };
      },
      abortSession: async () => ({ success: true, data: { aborted: true } }),
      replyPermission: async () => ({ success: true, data: { replied: true } }),
      replyQuestion: async () => ({ success: true, data: { replied: true } }),
      ...overrides.sessionScopedActionGatewayPort,
    },
  });
  return { adapter, calls };
}

describe('LegacyHostSessionGatewayAdapter', () => {
  test('maps get and list to existing host session query port', async () => {
    const { adapter, calls } = createAdapter();

    assert.deepStrictEqual(await adapter.get('ses-1'), { id: 'ses-1', directory: '/repo' });
    assert.deepStrictEqual(await adapter.list({
      directory: '/repo',
      roots: true,
      start: 1_777_766_400_000,
    }), [{ id: 'ses-1', directory: '/repo' }]);
    assert.deepStrictEqual(calls, [
      { method: 'getSession', sessionId: 'ses-1' },
      {
        method: 'listSessions',
        query: { directory: '/repo', roots: true, start: 1_777_766_400_000 },
      },
    ]);
  });

  test('maps dialog-only controlled create input to legacy session creation deny permissions', async () => {
    const { adapter, calls } = createAdapter();

    assert.deepStrictEqual(await adapter.create({
      title: 'Created',
      assistantId: 'assistant-ignored-by-legacy',
      directory: '/repo',
      control: {
        controlled: true,
        permissionProfile: 'dialog_only',
      },
    }), {
      id: 'ses-created',
      title: 'Created',
    });
    assert.deepStrictEqual(calls, [{
      method: 'createSession',
      input: {
        title: 'Created',
        directory: '/repo',
        permission: [
          { permission: 'bash', pattern: '*', action: 'deny' },
          { permission: 'read', pattern: '*', action: 'deny' },
          { permission: 'glob', pattern: '*', action: 'deny' },
          { permission: 'grep', pattern: '*', action: 'deny' },
          { permission: 'edit', pattern: '*', action: 'deny' },
          { permission: 'write', pattern: '*', action: 'deny' },
          { permission: 'task', pattern: '*', action: 'deny' },
          { permission: 'webfetch', pattern: '*', action: 'deny' },
          { permission: 'myAgentWebFetch', pattern: '*', action: 'deny' },
          { permission: 'meeting*', pattern: '*', action: 'deny' },
          { permission: 'knowledge*', pattern: '*', action: 'deny' },
          { permission: 'playwright*', pattern: '*', action: 'deny' },
        ],
      },
    }]);
  });

  test('maps prompt and delete to session scoped action gateway port', async () => {
    const { adapter, calls } = createAdapter();

    assert.deepStrictEqual(await adapter.prompt({
      sessionId: 'ses-1',
      text: 'hello',
      directory: '/scoped/repo',
      assistantId: 'assistant-1',
    }), { applied: true });
    assert.deepStrictEqual(await adapter.delete('ses-1'), { applied: true });
    assert.deepStrictEqual(calls, [
      {
        method: 'promptSession',
        input: {
          sessionId: 'ses-1',
          text: 'hello',
          directory: '/scoped/repo',
          agent: 'assistant-1',
        },
      },
      { method: 'closeSession', input: { sessionId: 'ses-1' } },
    ]);
  });

  test('throws when legacy action result reports failure', async () => {
    const { adapter } = createAdapter({
      sessionScopedActionGatewayPort: {
        promptSession: async () => ({
          success: false,
          errorCode: 'SDK_UNREACHABLE',
          errorMessage: 'prompt failed',
        }),
      },
    });

    await assert.rejects(
      () => adapter.prompt({ sessionId: 'ses-1', text: 'hello' }),
      /prompt failed/u,
    );
  });
});
