import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PendingInteractionLookupBridge } from '../../src/adapter/session-isolation/runtime/PendingInteractionLookupBridge.ts';
import { RuntimePendingInteractionRegistry } from '../../src/runtime/sdk/session-isolation/RuntimePendingInteractionRegistry.ts';

class MemoryPendingInteractionRegistry {
  records = new Map();

  register(record) {
    this.records.set(`${record.kind}:${record.tokenId}`, record);
    return { ok: true };
  }

  consume(input) {
    return this.records.get(`${input.kind}:${input.tokenId}`);
  }

  clearSession(toolSessionId) {
    for (const [key, record] of this.records.entries()) {
      if (record.toolSessionId === toolSessionId) {
        this.records.delete(key);
      }
    }
  }
}

class MemoryAnchorBindingRepository {
  records = new Map();

  async get(toolSessionId) {
    return this.records.get(toolSessionId);
  }

  async findBySessionId(sessionId) {
    return [...this.records.values()].filter((record) => record.sessionId === sessionId);
  }

  async upsert(record) {
    this.records.set(record.toolSessionId, record);
  }

  async delete(toolSessionId) {
    this.records.delete(toolSessionId);
  }
}

function createBridge() {
  const pendingInteractionRegistry = new MemoryPendingInteractionRegistry();
  const anchorBindingRepository = new MemoryAnchorBindingRepository();
  return {
    pendingInteractionRegistry,
    anchorBindingRepository,
    bridge: new PendingInteractionLookupBridge({
      pendingInteractionRegistry,
      anchorBindingRepository,
    }),
  };
}

function createBridgeWithUnusedLegacyQuestionList() {
  const pendingInteractionRegistry = new MemoryPendingInteractionRegistry();
  const anchorBindingRepository = new MemoryAnchorBindingRepository();
  const listCalls = [];
  const legacyQuestionListPort = {
    listQuestions: async () => {
      listCalls.push({ method: 'listQuestions' });
      return [{
        id: 'question-request-1',
        sessionID: 'ses-original',
      }];
    },
  };
  return {
    listCalls,
    legacyQuestionListPort,
    pendingInteractionRegistry,
    anchorBindingRepository,
    bridge: new PendingInteractionLookupBridge({
      pendingInteractionRegistry,
      anchorBindingRepository,
    }),
  };
}

describe('PendingInteractionLookupBridge', () => {
  test('findQuestion resolves pending question token to tool and host session', async () => {
    const { bridge, pendingInteractionRegistry, anchorBindingRepository } = createBridge();
    pendingInteractionRegistry.register({
      kind: 'question',
      tokenId: 'q-1',
      toolSessionId: 'tool-1',
      hostSessionId: 'ses-1',
    });
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-1',
      sessionId: 'ses-1',
      state: 'attached',
    });

    assert.deepStrictEqual(await bridge.findQuestion('q-1'), {
      kind: 'found',
      toolSessionId: 'tool-1',
      sessionId: 'ses-1',
    });
  });

  test('findPermission resolves pending permission token to tool and host session', async () => {
    const { bridge, pendingInteractionRegistry, anchorBindingRepository } = createBridge();
    pendingInteractionRegistry.register({
      kind: 'permission',
      tokenId: 'p-1',
      toolSessionId: 'tool-1',
      hostSessionId: 'ses-1',
    });
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-1',
      sessionId: 'ses-1',
      state: 'attached',
    });

    assert.deepStrictEqual(await bridge.findPermission('p-1'), {
      kind: 'found',
      toolSessionId: 'tool-1',
      sessionId: 'ses-1',
    });
  });

  test('findQuestion does not scan legacy question list when pending mapping is absent', async () => {
    const { bridge, anchorBindingRepository, listCalls } = createBridgeWithUnusedLegacyQuestionList();
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-original',
      sessionId: 'ses-original',
      state: 'attached',
    });
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-new-active',
      sessionId: 'ses-new-active',
      state: 'attached',
    });

    assert.deepStrictEqual(await bridge.findQuestion('question-request-1'), { kind: 'missing' });
    assert.deepStrictEqual(listCalls, []);
  });

  test('returns missing when interaction mapping is absent or no attached binding exists', async () => {
    const { bridge, pendingInteractionRegistry } = createBridge();
    pendingInteractionRegistry.register({
      kind: 'question',
      tokenId: 'q-without-binding',
      toolSessionId: 'tool-missing-binding',
      hostSessionId: 'ses-missing-binding',
    });

    assert.deepStrictEqual(await bridge.findQuestion('q-missing'), { kind: 'missing' });
    assert.deepStrictEqual(await bridge.findQuestion('q-without-binding'), { kind: 'missing' });
  });

  test('returns missing when the anchor has switched to a different host session after interaction registration', async () => {
    const { bridge, pendingInteractionRegistry, anchorBindingRepository } = createBridge();
    pendingInteractionRegistry.register({
      kind: 'permission',
      tokenId: 'p-switched',
      toolSessionId: 'tool-switched',
      hostSessionId: 'ses-original',
    });
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-switched',
      sessionId: 'ses-current',
      state: 'attached',
    });

    assert.deepStrictEqual(await bridge.findPermission('p-switched'), { kind: 'missing' });
  });

  test('does not fall back to legacy question list when registered question binding has switched', async () => {
    const { bridge, pendingInteractionRegistry, anchorBindingRepository, listCalls } = createBridgeWithUnusedLegacyQuestionList();
    pendingInteractionRegistry.register({
      kind: 'question',
      tokenId: 'q-switched',
      toolSessionId: 'tool-switched',
      hostSessionId: 'ses-original',
    });
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-switched',
      sessionId: 'ses-current',
      state: 'attached',
    });
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-original',
      sessionId: 'ses-original',
      state: 'attached',
    });

    assert.deepStrictEqual(await bridge.findQuestion('q-switched'), { kind: 'missing' });
    assert.deepStrictEqual(listCalls, []);
  });

  test('consumes pending interaction only once', async () => {
    const pendingInteractionRegistry = new RuntimePendingInteractionRegistry();
    const anchorBindingRepository = new MemoryAnchorBindingRepository();
    const bridge = new PendingInteractionLookupBridge({
      pendingInteractionRegistry,
      anchorBindingRepository,
    });
    pendingInteractionRegistry.register({
      kind: 'question',
      tokenId: 'q-once',
      toolSessionId: 'tool-once',
      hostSessionId: 'ses-once',
    });
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-once',
      sessionId: 'ses-once',
      state: 'attached',
    });

    assert.deepStrictEqual(await bridge.findQuestion('q-once'), {
      kind: 'found',
      toolSessionId: 'tool-once',
      sessionId: 'ses-once',
    });
    assert.deepStrictEqual(await bridge.findQuestion('q-once'), { kind: 'missing' });
  });
});
