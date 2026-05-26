import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryOpencodeSessionOwnershipResolver,
  InMemoryToolSessionBindingStore,
} from '../../src/adapter/index.ts';
import { createSessionIsolationControlPlane } from '../../src/runtime/sdk/session-isolation/index.ts';

const entryKey = {
  businessSessionDomain: 'im',
  businessSessionType: 'group',
  businessSessionId: 'group-a',
};

describe('createSessionIsolationControlPlane', () => {
  test('wires formal chat command path through host adapter and ownership repositories', async () => {
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const calls = [];
    const graph = createSessionIsolationControlPlane({
      akScopeKey: 'ak-test',
      bindingStore,
      ownershipResolver,
      businessEntryKeyResolver: {
        resolve: () => entryKey,
      },
      hostSessionQueryPort: {
        getSession: async (sessionId) => ({ id: sessionId }),
        listSessions: async () => [],
      },
      sessionCreationPort: {
        createSession: async (input) => {
          calls.push({ method: 'createSession', input });
          return {
            success: true,
            data: { sessionId: 'ses-created', session: { id: 'ses-created', title: input.title } },
          };
        },
      },
      sessionScopedActionGatewayPort: {
        promptSession: async (input) => {
          calls.push({ method: 'promptSession', input });
          return { success: true, data: { prompted: true } };
        },
        closeSession: async () => ({ success: true, data: { closed: true } }),
        abortSession: async () => ({ success: true, data: { aborted: true } }),
        replyPermission: async () => ({ success: true, data: { replied: true } }),
        replyQuestion: async () => ({ success: true, data: { replied: true } }),
      },
      pendingInteractionRegistry: {
        consume: () => undefined,
        register: () => {},
      },
      ownedHostEventForwarder: {
        forward: async (input) => {
          calls.push({ method: 'forwardHostEvent', input });
          return { applied: true };
        },
      },
    });

    assert.equal(typeof graph.hostEventPort.handle, 'function');
    assert.deepStrictEqual(await graph.chatCommandPort.execute({
      toolSessionId: 'tool-1',
      text: 'hello',
      assistantId: 'assistant-1',
      extParameters: {},
    }), {
      kind: 'prompted',
      toolSessionId: 'tool-1',
      sessionId: 'ses-created',
    });
    assert.deepStrictEqual(bindingStore.get('tool-1'), {
      anchor: 'tool-1',
      activeOpencodeSessionId: 'ses-created',
      status: 'active',
    });
    assert.strictEqual(ownershipResolver.resolveAttachedAnchor('ses-created'), 'tool-1');
    assert.equal(calls[0].method, 'createSession');
    assert.deepStrictEqual(calls[0].input.permission, [
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
    ]);
    assert.deepStrictEqual(calls.slice(1), [
      {
        method: 'promptSession',
        input: { sessionId: 'ses-created', text: 'hello', agent: 'assistant-1' },
      },
    ]);
  });
});
