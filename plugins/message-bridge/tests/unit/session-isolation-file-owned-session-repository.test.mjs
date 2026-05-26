import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  AkScopedEntrySessionStorePathResolver,
  FileOwnedSessionRepository,
} from '../../src/adapter/session-isolation/repository/index.ts';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mb-owned-sessions-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ownedRecord = {
  akScopeKey: 'ak-test',
  entryKey: 'im:group:group-a',
  sessionId: 'ses-owned',
  controlled: true,
  permissionProfile: 'dialog_only',
};

describe('FileOwnedSessionRepository', () => {
  test('path resolver uses sha256 auth ak scope below user data directory', () => {
    const resolver = new AkScopedEntrySessionStorePathResolver({
      dataDir: '/tmp/message-bridge-data',
    });
    const expectedScope = createHash('sha256').update('ak-secret').digest('hex');

    assert.equal(
      resolver.resolve({ authAk: 'ak-secret' }),
      join('/tmp/message-bridge-data', 'message-bridge', 'sessions', expectedScope, 'entry-session-store.json'),
    );
  });

  test('returns empty records when store file does not exist', async () => {
    await withTempDir(async (dir) => {
      const repository = new FileOwnedSessionRepository({ filePath: join(dir, 'entry-session-store.json') });

      assert.deepStrictEqual(await repository.findByEntryKey({
        akScopeKey: 'ignored-by-file-scope',
        entryKey: 'im:group:group-a',
      }), []);
      assert.strictEqual(await repository.findBySessionId({
        akScopeKey: 'ignored-by-file-scope',
        sessionId: 'ses-owned',
      }), undefined);
    });
  });

  test('persists owned session records across repository instances', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'entry-session-store.json');
      await new FileOwnedSessionRepository({ filePath }).upsert(ownedRecord);

      const reloaded = new FileOwnedSessionRepository({ filePath });

      assert.deepStrictEqual(await reloaded.findByEntryKey({
        akScopeKey: 'ak-test',
        entryKey: 'im:group:group-a',
      }), [ownedRecord]);
      assert.deepStrictEqual(await reloaded.findBySessionId({
        akScopeKey: 'ak-test',
        sessionId: 'ses-owned',
      }), ownedRecord);
      const persisted = JSON.parse(await readFile(filePath, 'utf8'));
      assert.equal(typeof persisted.sessions['ses-owned'].createdAt, 'number');
      assert.deepStrictEqual({
        ...persisted,
        sessions: {
          ...persisted.sessions,
          'ses-owned': {
            ...persisted.sessions['ses-owned'],
            createdAt: 0,
          },
        },
      }, {
        schemaVersion: 1,
        sessions: {
          'ses-owned': {
            origin: 'welink-entry-owned',
            entryKey: 'im:group:group-a',
            controlled: true,
            permissionProfile: 'dialog_only',
            createdAt: 0,
          },
        },
      });
    });
  });

  test('deletes only the requested session id from the store', async () => {
    await withTempDir(async (dir) => {
      const repository = new FileOwnedSessionRepository({ filePath: join(dir, 'entry-session-store.json') });
      await repository.upsert(ownedRecord);
      await repository.upsert({
        ...ownedRecord,
        sessionId: 'ses-kept',
      });

      await repository.deleteBySessionId({ akScopeKey: 'ak-test', sessionId: 'ses-owned' });

      assert.strictEqual(await repository.findBySessionId({
        akScopeKey: 'ak-test',
        sessionId: 'ses-owned',
      }), undefined);
      assert.deepStrictEqual(await repository.findBySessionId({
        akScopeKey: 'ak-test',
        sessionId: 'ses-kept',
      }), {
        ...ownedRecord,
        sessionId: 'ses-kept',
      });
    });
  });

  test('fails closed for corrupted json and backs it up before first successful write', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'entry-session-store.json');
      await writeFile(filePath, '{ broken json', 'utf8');
      const backupPaths = [];
      const repository = new FileOwnedSessionRepository({
        filePath,
        now: () => 1234,
        onCorruptBackup: (backupPath) => backupPaths.push(backupPath),
      });

      assert.deepStrictEqual(await repository.findByEntryKey({
        akScopeKey: 'ak-test',
        entryKey: 'im:group:group-a',
      }), []);

      await repository.upsert(ownedRecord);

      assert.deepStrictEqual(backupPaths, [`${filePath}.corrupt.1234`]);
      assert.equal(await readFile(`${filePath}.corrupt.1234`, 'utf8'), '{ broken json');
      assert.deepStrictEqual(await repository.findBySessionId({
        akScopeKey: 'ak-test',
        sessionId: 'ses-owned',
      }), ownedRecord);
    });
  });

  test('skips invalid session records while keeping valid records', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'entry-session-store.json');
      const diagnostics = [];
      await writeFile(filePath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          valid: {
            origin: 'welink-entry-owned',
            entryKey: 'im:group:group-a',
            controlled: true,
            permissionProfile: 'dialog_only',
            createdAt: 100,
          },
          invalid: {
            origin: 'welink-entry-owned',
            entryKey: 'im:group:group-a',
            controlled: true,
            permissionProfile: 'invalid-profile',
            createdAt: 100,
          },
        },
      }), 'utf8');
      const repository = new FileOwnedSessionRepository({
        filePath,
        onInvalidRecord: (sessionId) => diagnostics.push(sessionId),
      });

      assert.deepStrictEqual(await repository.findByEntryKey({
        akScopeKey: 'ak-test',
        entryKey: 'im:group:group-a',
      }), [{
        akScopeKey: 'ak-test',
        entryKey: 'im:group:group-a',
        sessionId: 'valid',
        controlled: true,
        permissionProfile: 'dialog_only',
      }]);
      assert.deepStrictEqual(diagnostics, ['invalid']);
    });
  });

  test('uses unique temp paths when multiple writes happen at the same timestamp', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'entry-session-store.json');
      const repository = new FileOwnedSessionRepository({
        filePath,
        now: () => 1234,
      });

      await repository.upsert(ownedRecord);
      await repository.upsert({
        ...ownedRecord,
        sessionId: 'ses-second',
      });

      assert.deepStrictEqual(await repository.findBySessionId({
        akScopeKey: 'ak-test',
        sessionId: 'ses-owned',
      }), ownedRecord);
      assert.deepStrictEqual(await repository.findBySessionId({
        akScopeKey: 'ak-test',
        sessionId: 'ses-second',
      }), {
        ...ownedRecord,
        sessionId: 'ses-second',
      });
    });
  });

  test('serializes concurrent writes so upserts do not overwrite each other', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'entry-session-store.json');
      const repository = new FileOwnedSessionRepository({
        filePath,
        now: () => 1234,
      });

      await Promise.all([
        repository.upsert(ownedRecord),
        repository.upsert({
          ...ownedRecord,
          sessionId: 'ses-concurrent-second',
        }),
      ]);

      assert.deepStrictEqual(
        (await repository.findByEntryKey({
          akScopeKey: 'ak-test',
          entryKey: 'im:group:group-a',
        })).map((record) => record.sessionId).sort(),
        ['ses-concurrent-second', 'ses-owned'],
      );
    });
  });
});
