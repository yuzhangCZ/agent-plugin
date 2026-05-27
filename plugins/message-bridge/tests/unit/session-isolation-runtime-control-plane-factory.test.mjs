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

function createPendingInteractionRegistry() {
  const records = new Map();
  const key = (record) => `${record.kind}:${record.tokenId}`;

  return {
    register: (record) => {
      records.set(key(record), record);
    },
    peek: (input) => records.get(`${input.kind}:${input.tokenId}`),
    consumeIfMatch: (record) => {
      const recordKey = key(record);
      const current = records.get(recordKey);
      if (
        !current
        || current.kind !== record.kind
        || current.tokenId !== record.tokenId
        || current.toolSessionId !== record.toolSessionId
        || current.hostSessionId !== record.hostSessionId
      ) {
        return undefined;
      }
      records.delete(recordKey);
      return current;
    },
  };
}

function createLogger(entries) {
  const info = (message, extra) => entries.push({ level: 'info', message, extra });
  return {
    debug: () => undefined,
    info,
    warn: () => undefined,
    error: () => undefined,
    child: () => createLogger(entries),
    getTraceId: () => 'trace-test',
  };
}

describe('createSessionIsolationControlPlane', () => {
  test('wires create_session command path through host adapter and ownership repositories', async () => {
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const calls = [];
    const logs = [];
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
      pendingInteractionRegistry: createPendingInteractionRegistry(),
      ownedHostEventForwarder: {
        forward: async (input) => {
          calls.push({ method: 'forwardHostEvent', input });
          return { applied: true };
        },
      },
      logger: createLogger(logs),
    });

    assert.equal(typeof graph.hostEventPort.handle, 'function');
    assert.deepStrictEqual(await graph.createSessionCommandPort.execute({
      title: 'hello',
      assistantId: 'assistant-1',
      extParameters: {
        platformExtParam: entryKey,
      },
    }), {
      kind: 'entry_owned',
      toolSessionId: 'ses-created',
      session: {
        id: 'ses-created',
        title: 'hello',
      },
    });
    assert.deepStrictEqual(bindingStore.get('ses-created'), {
      anchor: 'ses-created',
      activeOpencodeSessionId: 'ses-created',
      status: 'active',
    });
    assert.strictEqual(ownershipResolver.resolveAttachedAnchor('ses-created'), 'ses-created');
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
    assert.equal(calls[0].input.title, 'hello');
    assert.equal(calls.length, 1);
    assert.equal(logs.some((entry) => entry.message === 'session_isolation.ownership.bound'), true);
  });
});
