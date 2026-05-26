import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultEntryKeyCodec } from '../../src/domain/session-isolation/EntryKeyCodec.ts';
import { DefaultOwnedSessionCoordinator } from '../../src/usecase/session-isolation/OwnedSessionCoordinator.ts';
import { SessionIsolationDiagnostics } from '../../src/runtime/sdk/session-isolation/index.ts';

class MemoryOwnedSessionRepository {
  records = new Map();

  async findByEntryKey(input) {
    return [...this.records.values()].filter(
      (record) => record.akScopeKey === input.akScopeKey && record.entryKey === input.entryKey,
    );
  }

  async upsert(record) {
    this.records.set(`${record.akScopeKey}:${record.sessionId}`, record);
  }

  async deleteBySessionId(input) {
    this.records.delete(`${input.akScopeKey}:${input.sessionId}`);
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

class MemoryAttachOwnerRepository {
  records = new Map();

  async get(sessionId) {
    return this.records.get(sessionId);
  }

  async upsert(record) {
    this.records.set(record.sessionId, record);
  }

  async delete(sessionId) {
    this.records.delete(sessionId);
  }
}

function createCoordinator() {
  const ownedSessionRepository = new MemoryOwnedSessionRepository();
  const anchorBindingRepository = new MemoryAnchorBindingRepository();
  const attachOwnerRepository = new MemoryAttachOwnerRepository();
  return {
    ownedSessionRepository,
    anchorBindingRepository,
    attachOwnerRepository,
    coordinator: new DefaultOwnedSessionCoordinator({
      akScopeKey: 'ak-test',
      entryKeyCodec: new DefaultEntryKeyCodec(),
      ownedSessionRepository,
      anchorBindingRepository,
      attachOwnerRepository,
    }),
  };
}

describe('DefaultOwnedSessionCoordinator', () => {
  test('bindOwnedSession writes ownership, active anchor binding, and attach owner', async () => {
    const {
      coordinator,
      ownedSessionRepository,
      anchorBindingRepository,
      attachOwnerRepository,
    } = createCoordinator();

    await coordinator.bindOwnedSession({
      toolSessionId: 'tool-1',
      sessionId: 'ses-1',
      entryKey: {
        businessSessionDomain: 'IM',
        businessSessionType: 'Group',
        businessSessionId: 'GroupA',
      },
    });

    assert.deepStrictEqual([...ownedSessionRepository.records.values()], [{
      akScopeKey: 'ak-test',
      entryKey: 'im:group:GroupA',
      sessionId: 'ses-1',
      controlled: true,
      permissionProfile: 'dialog_only',
    }]);
    assert.deepStrictEqual(await anchorBindingRepository.get('tool-1'), {
      toolSessionId: 'tool-1',
      sessionId: 'ses-1',
      state: 'attached',
    });
    assert.deepStrictEqual(await attachOwnerRepository.get('ses-1'), {
      sessionId: 'ses-1',
      toolSessionId: 'tool-1',
    });
  });

  test('bindOwnedSession persists default permission profile for uncontrolled entries', async () => {
    const {
      coordinator,
      ownedSessionRepository,
    } = createCoordinator();

    await coordinator.bindOwnedSession({
      toolSessionId: 'tool-direct',
      sessionId: 'ses-direct',
      entryKey: {
        businessSessionDomain: 'im',
        businessSessionType: 'direct',
        businessSessionId: 'UserA',
      },
      policy: {
        entryKey: 'im:direct:UserA',
        controlled: false,
        allowOpencodeNativeSessions: true,
        allowedSlashCommands: ['new', 'sessions', 'session', 'models', 'model'],
      },
    });

    assert.deepStrictEqual([...ownedSessionRepository.records.values()], [{
      akScopeKey: 'ak-test',
      entryKey: 'im:direct:UserA',
      sessionId: 'ses-direct',
      controlled: false,
      permissionProfile: 'default',
    }]);
  });

  test('bindOwnedSession clears the previous attach owner when rebinding the same anchor to a new session', async () => {
    const { coordinator, anchorBindingRepository, attachOwnerRepository } = createCoordinator();
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-1',
      sessionId: 'ses-old',
      state: 'attached',
    });
    await attachOwnerRepository.upsert({
      sessionId: 'ses-old',
      toolSessionId: 'tool-1',
    });

    await coordinator.bindOwnedSession({
      toolSessionId: 'tool-1',
      sessionId: 'ses-new',
      entryKey: {
        businessSessionDomain: 'im',
        businessSessionType: 'group',
        businessSessionId: 'group-new',
      },
    });

    assert.strictEqual(await attachOwnerRepository.get('ses-old'), undefined);
    assert.deepStrictEqual(await anchorBindingRepository.get('tool-1'), {
      toolSessionId: 'tool-1',
      sessionId: 'ses-new',
      state: 'attached',
    });
    assert.deepStrictEqual(await attachOwnerRepository.get('ses-new'), {
      sessionId: 'ses-new',
      toolSessionId: 'tool-1',
    });
  });

  test('switchAttachedSession replaces the previous attach owner and binding', async () => {
    const { coordinator, anchorBindingRepository, attachOwnerRepository } = createCoordinator();
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-1',
      sessionId: 'ses-old',
      state: 'attached',
    });
    await attachOwnerRepository.upsert({ sessionId: 'ses-old', toolSessionId: 'tool-1' });

    await coordinator.switchAttachedSession({
      toolSessionId: 'tool-1',
      sessionId: 'ses-new',
    });

    assert.strictEqual(await attachOwnerRepository.get('ses-old'), undefined);
    assert.deepStrictEqual(await anchorBindingRepository.get('tool-1'), {
      toolSessionId: 'tool-1',
      sessionId: 'ses-new',
      state: 'attached',
    });
    assert.deepStrictEqual(await attachOwnerRepository.get('ses-new'), {
      sessionId: 'ses-new',
      toolSessionId: 'tool-1',
    });
  });

  test('closeOwnedSession removes binding, attach owner, and owned session record', async () => {
    const { coordinator, ownedSessionRepository, anchorBindingRepository, attachOwnerRepository } = createCoordinator();
    await coordinator.bindOwnedSession({
      toolSessionId: 'tool-close',
      sessionId: 'ses-close',
      entryKey: {
        businessSessionDomain: 'im',
        businessSessionType: 'direct',
        businessSessionId: 'UserA#BotA',
      },
    });

    await coordinator.closeOwnedSession({ toolSessionId: 'tool-close' });

    assert.strictEqual(await anchorBindingRepository.get('tool-close'), undefined);
    assert.strictEqual(await attachOwnerRepository.get('ses-close'), undefined);
    assert.deepStrictEqual([...ownedSessionRepository.records.values()], []);
  });

  test('reconcileDeletedSession is idempotent and clears every binding for the deleted host session', async () => {
    const { coordinator, anchorBindingRepository, attachOwnerRepository, ownedSessionRepository } = createCoordinator();
    await coordinator.bindOwnedSession({
      toolSessionId: 'tool-a',
      sessionId: 'ses-deleted',
      entryKey: {
        businessSessionDomain: 'im',
        businessSessionType: 'group',
        businessSessionId: 'group-a',
      },
    });
    await anchorBindingRepository.upsert({
      toolSessionId: 'tool-b',
      sessionId: 'ses-deleted',
      state: 'attached',
    });

    await coordinator.reconcileDeletedSession({ sessionId: 'ses-deleted' });
    await coordinator.reconcileDeletedSession({ sessionId: 'ses-deleted' });

    assert.strictEqual(await anchorBindingRepository.get('tool-a'), undefined);
    assert.strictEqual(await anchorBindingRepository.get('tool-b'), undefined);
    assert.strictEqual(await attachOwnerRepository.get('ses-deleted'), undefined);
    assert.deepStrictEqual([...ownedSessionRepository.records.values()], []);
  });

  test('records ownership mutation failure diagnostics before rethrowing', async () => {
    const diagnostics = new SessionIsolationDiagnostics();
    const error = new Error('owned store unavailable');
    const coordinator = new DefaultOwnedSessionCoordinator({
      akScopeKey: 'ak-test',
      entryKeyCodec: new DefaultEntryKeyCodec(),
      ownedSessionRepository: {
        upsert: async () => {
          throw error;
        },
        deleteBySessionId: async () => undefined,
        findByEntryKey: async () => [],
        findBySessionId: async () => undefined,
      },
      anchorBindingRepository: new MemoryAnchorBindingRepository(),
      attachOwnerRepository: new MemoryAttachOwnerRepository(),
      diagnostics,
    });

    await assert.rejects(
      () => coordinator.bindOwnedSession({
        toolSessionId: 'tool-failed',
        sessionId: 'ses-failed',
        entryKey: {
          businessSessionDomain: 'im',
          businessSessionType: 'group',
          businessSessionId: 'group-failed',
        },
      }),
      /owned store unavailable/u,
    );

    assert.deepStrictEqual(diagnostics.getSnapshot().lastEvent, {
      kind: 'ownership_mutation_failed',
      severity: 'error',
      operation: 'bindOwnedSession',
      toolSessionId: 'tool-failed',
      sessionId: 'ses-failed',
      errorMessage: 'owned store unavailable',
    });
  });
});
