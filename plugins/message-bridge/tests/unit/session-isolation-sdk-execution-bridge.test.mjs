import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionScopedSdkExecutionBridge } from '../../src/adapter/session-isolation/runtime/SessionScopedSdkExecutionBridge.ts';

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

function createGatewayPort(overrides = {}) {
  const calls = [];
  return {
    calls,
    port: {
      abortSession: async (input) => {
        calls.push({ method: 'abortSession', input });
        return { success: true, data: { aborted: true } };
      },
      replyQuestion: async (input) => {
        calls.push({ method: 'replyQuestion', input });
        return { success: true, data: { replied: true } };
      },
      replyPermission: async (input) => {
        calls.push({ method: 'replyPermission', input });
        return { success: true, data: { replied: true } };
      },
      ...overrides,
    },
  };
}

describe('SessionScopedSdkExecutionBridge', () => {
  test('abort resolves toolSessionId through anchor binding before calling host gateway', async () => {
    const anchorBindingRepository = new MemoryAnchorBindingRepository();
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-1',
      sessionId: 'ses-1',
      state: 'attached',
    });
    const { port, calls } = createGatewayPort();
    const bridge = new SessionScopedSdkExecutionBridge({
      anchorBindingRepository,
      gatewayPort: port,
    });

    assert.deepStrictEqual(await bridge.abort({ toolSessionId: 'tool-1' }), {
      kind: 'aborted',
      toolSessionId: 'tool-1',
      hostSessionId: 'ses-1',
    });
    assert.deepStrictEqual(calls, [{
      method: 'abortSession',
      input: { sessionId: 'ses-1' },
    }]);
  });

  test('abort returns not_active when no attached binding exists', async () => {
    const { port, calls } = createGatewayPort();
    const bridge = new SessionScopedSdkExecutionBridge({
      anchorBindingRepository: new MemoryAnchorBindingRepository(),
      gatewayPort: port,
    });

    assert.deepStrictEqual(await bridge.abort({ toolSessionId: 'tool-missing' }), {
      kind: 'not_active',
      toolSessionId: 'tool-missing',
    });
    assert.deepStrictEqual(calls, []);
  });

  test('replyQuestion and replyPermission delegate to gateway port', async () => {
    const { port, calls } = createGatewayPort();
    const bridge = new SessionScopedSdkExecutionBridge({
      anchorBindingRepository: new MemoryAnchorBindingRepository(),
      gatewayPort: port,
    });

    assert.deepStrictEqual(await bridge.replyQuestion({
      questionId: 'q-1',
      answer: 'yes',
    }), { applied: true });
    assert.deepStrictEqual(await bridge.replyPermission({
      permissionId: 'p-1',
      response: 'once',
    }), { applied: true });
    assert.deepStrictEqual(calls, [
      {
        method: 'replyQuestion',
        input: { questionId: 'q-1', answer: 'yes' },
      },
      {
        method: 'replyPermission',
        input: { permissionId: 'p-1', response: 'once' },
      },
    ]);
  });

  test('throws when gateway port rejects command application', async () => {
    const { port } = createGatewayPort({
      replyQuestion: async () => ({
        success: false,
        errorCode: 'INVALID_PAYLOAD',
        errorMessage: 'question not found',
      }),
    });
    const bridge = new SessionScopedSdkExecutionBridge({
      anchorBindingRepository: new MemoryAnchorBindingRepository(),
      gatewayPort: port,
    });

    await assert.rejects(
      () => bridge.replyQuestion({ questionId: 'q-missing', answer: 'yes' }),
      /question not found/u,
    );
  });
});
