import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryOpencodeSessionOwnershipResolver,
  InMemoryToolSessionBindingStore,
} from '../../src/adapter/index.ts';
import { RuntimeSessionIsolationFacade } from '../../src/runtime/sdk/session-isolation/RuntimeSessionIsolationFacade.ts';

function createFacade() {
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  return {
    bindingStore,
    ownershipResolver,
    facade: new RuntimeSessionIsolationFacade({
      bindingStore,
      ownershipResolver,
    }),
  };
}

describe('RuntimeSessionIsolationFacade', () => {
  test('registerCreatedSession establishes binding and event ownership through one runtime entry point', async () => {
    const { bindingStore, ownershipResolver, facade } = createFacade();

    await facade.registerCreatedSession({
      anchor: 'tool-created-1',
      opencodeSessionId: 'ses-created-1',
    });

    assert.deepStrictEqual(bindingStore.get('tool-created-1'), {
      anchor: 'tool-created-1',
      activeOpencodeSessionId: 'ses-created-1',
      status: 'active',
    });
    assert.strictEqual(ownershipResolver.resolveAttachedAnchor('ses-created-1'), 'tool-created-1');
  });

  test('invalidateAfterControlPlaneFailure ignores unrelated failures', async () => {
    const { bindingStore, ownershipResolver, facade } = createFacade();
    await facade.registerCreatedSession({
      anchor: 'tool-active-1',
      opencodeSessionId: 'ses-active-1',
    });

    await facade.invalidateAfterControlPlaneFailure('tool-active-1', {
      errorEvidence: {
        sourceErrorCode: 'permission_denied',
        sourceOperation: 'session.prompt',
      },
    });

    assert.strictEqual(bindingStore.get('tool-active-1')?.status, 'active');
    assert.strictEqual(ownershipResolver.resolveAttachedAnchor('ses-active-1'), 'tool-active-1');
  });

  test('invalidateAfterControlPlaneFailure invalidates stale binding and detaches ownership', async () => {
    const { bindingStore, ownershipResolver, facade } = createFacade();
    await facade.registerCreatedSession({
      anchor: 'tool-stale-1',
      opencodeSessionId: 'ses-stale-1',
    });

    await facade.invalidateAfterControlPlaneFailure('tool-stale-1', {
      errorEvidence: {
        sourceErrorCode: 'session_not_found',
        sourceOperation: 'session.prompt',
      },
    });

    assert.strictEqual(bindingStore.get('tool-stale-1')?.status, 'invalid');
    assert.strictEqual(ownershipResolver.resolveAttachedAnchor('ses-stale-1'), undefined);
  });
});
