import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryOpencodeSessionOwnershipResolver,
  InMemoryToolSessionBindingStore,
} from '../../src/adapter/index.ts';
import {
  LegacyAnchorBindingRepository,
  LegacyAttachOwnerRepository,
  InMemoryOwnedSessionRepository,
} from '../../src/adapter/session-isolation/repository/index.ts';

describe('session-isolation repository adapters', () => {
  test('LegacyAnchorBindingRepository maps legacy binding store records to anchor binding records', async () => {
    const bindingStore = new InMemoryToolSessionBindingStore();
    const repository = new LegacyAnchorBindingRepository(bindingStore);

    await repository.upsert({
      toolSessionId: 'tool-1',
      sessionId: 'ses-1',
      state: 'attached',
    });

    assert.deepStrictEqual(await repository.get('tool-1'), {
      toolSessionId: 'tool-1',
      sessionId: 'ses-1',
      state: 'attached',
    });
    assert.deepStrictEqual(await repository.findBySessionId('ses-1'), [{
      toolSessionId: 'tool-1',
      sessionId: 'ses-1',
      state: 'attached',
    }]);

    await repository.delete('tool-1');
    assert.strictEqual(await repository.get('tool-1'), undefined);
  });

  test('LegacyAttachOwnerRepository maps ownership resolver attachment state', async () => {
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const repository = new LegacyAttachOwnerRepository(ownershipResolver);

    await repository.upsert({ sessionId: 'ses-1', toolSessionId: 'tool-1' });

    assert.deepStrictEqual(await repository.get('ses-1'), {
      sessionId: 'ses-1',
      toolSessionId: 'tool-1',
    });

    await repository.delete('ses-1');
    assert.strictEqual(await repository.get('ses-1'), undefined);
  });

  test('InMemoryOwnedSessionRepository stores records by ak scope and session id', async () => {
    const repository = new InMemoryOwnedSessionRepository();
    await repository.upsert({
      akScopeKey: 'ak-1',
      entryKey: 'im:group:group-a',
      sessionId: 'ses-1',
      controlled: true,
      permissionProfile: 'default',
    });
    await repository.upsert({
      akScopeKey: 'ak-2',
      entryKey: 'im:group:group-a',
      sessionId: 'ses-2',
      controlled: true,
      permissionProfile: 'default',
    });

    assert.deepStrictEqual(await repository.findByEntryKey({
      akScopeKey: 'ak-1',
      entryKey: 'im:group:group-a',
    }), [{
      akScopeKey: 'ak-1',
      entryKey: 'im:group:group-a',
      sessionId: 'ses-1',
      controlled: true,
      permissionProfile: 'default',
    }]);
    assert.deepStrictEqual(await repository.findBySessionId({
      akScopeKey: 'ak-1',
      sessionId: 'ses-1',
    }), {
      akScopeKey: 'ak-1',
      entryKey: 'im:group:group-a',
      sessionId: 'ses-1',
      controlled: true,
      permissionProfile: 'default',
    });
    assert.strictEqual(await repository.findBySessionId({
      akScopeKey: 'ak-2',
      sessionId: 'ses-1',
    }), undefined);

    await repository.deleteBySessionId({ akScopeKey: 'ak-1', sessionId: 'ses-1' });
    assert.deepStrictEqual(await repository.findByEntryKey({
      akScopeKey: 'ak-1',
      entryKey: 'im:group:group-a',
    }), []);
  });
});
