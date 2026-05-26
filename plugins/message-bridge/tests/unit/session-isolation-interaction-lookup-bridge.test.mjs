import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PendingInteractionLookupBridge } from '../../src/adapter/session-isolation/runtime/PendingInteractionLookupBridge.ts';

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

function createBridgeWithLegacyQuestionList(questionRecords) {
  const pendingInteractionRegistry = new MemoryPendingInteractionRegistry();
  const anchorBindingRepository = new MemoryAnchorBindingRepository();
  const listCalls = [];
  return {
    listCalls,
    pendingInteractionRegistry,
    anchorBindingRepository,
    bridge: new PendingInteractionLookupBridge({
      pendingInteractionRegistry,
      anchorBindingRepository,
      legacyQuestionListPort: {
        listQuestions: async () => {
          listCalls.push({ method: 'listQuestions' });
          return questionRecords;
        },
      },
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

  test('findQuestion falls back to legacy question list and preserves original attached host session', async () => {
    const { bridge, anchorBindingRepository, listCalls } = createBridgeWithLegacyQuestionList([
      {
        id: 'question-request-1',
        sessionID: 'ses-original',
      },
    ]);
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

    assert.deepStrictEqual(await bridge.findQuestion('question-request-1'), {
      kind: 'found',
      toolSessionId: 'tool-original',
      sessionId: 'ses-original',
    });
    assert.deepStrictEqual(listCalls, [{ method: 'listQuestions' }]);
  });

  test('returns missing when interaction mapping is absent or no attached binding exists', async () => {
    const { bridge, pendingInteractionRegistry } = createBridge();
    pendingInteractionRegistry.register({
      kind: 'question',
      tokenId: 'q-without-binding',
      toolSessionId: 'tool-missing-binding',
    });

    assert.deepStrictEqual(await bridge.findQuestion('q-missing'), { kind: 'missing' });
    assert.deepStrictEqual(await bridge.findQuestion('q-without-binding'), { kind: 'missing' });
  });
});
