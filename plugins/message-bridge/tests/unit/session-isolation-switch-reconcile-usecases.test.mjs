import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DefaultSessionDeletedReconcileUseCase,
  DefaultSwitchAttachedSessionUseCase,
} from '../../src/usecase/session-isolation/index.ts';

function createOwnedSessionCoordinator() {
  const calls = [];
  return {
    calls,
    coordinator: {
      bindOwnedSession: async (input) => {
        calls.push({ method: 'bindOwnedSession', input });
        return { applied: true };
      },
      switchAttachedSession: async (input) => {
        calls.push({ method: 'switchAttachedSession', input });
        return { applied: true };
      },
      closeOwnedSession: async (input) => {
        calls.push({ method: 'closeOwnedSession', input });
        return { applied: true };
      },
      reconcileDeletedSession: async (input) => {
        calls.push({ method: 'reconcileDeletedSession', input });
        return { applied: true };
      },
    },
  };
}

describe('session-isolation switch and reconcile use cases', () => {
  test('SwitchAttachedSessionUseCase delegates attach switching to OwnedSessionCoordinator', async () => {
    const { coordinator, calls } = createOwnedSessionCoordinator();
    const useCase = new DefaultSwitchAttachedSessionUseCase({ ownedSessionCoordinator: coordinator });

    assert.deepStrictEqual(await useCase.execute({
      toolSessionId: 'tool-1',
      sessionId: 'ses-next',
    }), { applied: true });
    assert.deepStrictEqual(calls, [{
      method: 'switchAttachedSession',
      input: {
        toolSessionId: 'tool-1',
        sessionId: 'ses-next',
      },
    }]);
  });

  test('SessionDeletedReconcileUseCase delegates deleted-session cleanup to OwnedSessionCoordinator', async () => {
    const { coordinator, calls } = createOwnedSessionCoordinator();
    const useCase = new DefaultSessionDeletedReconcileUseCase({ ownedSessionCoordinator: coordinator });

    assert.deepStrictEqual(await useCase.execute({ sessionId: 'ses-deleted' }), { applied: true });
    assert.deepStrictEqual(calls, [{
      method: 'reconcileDeletedSession',
      input: { sessionId: 'ses-deleted' },
    }]);
  });
});
