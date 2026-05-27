import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

async function assertFileExists(relativePath) {
  await access(join(ROOT, relativePath));
}

async function assertReExportOnly(relativePath) {
  const source = await readFile(join(ROOT, relativePath), 'utf8');
  const statements = source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  assert.ok(statements.length > 0, `${relativePath} should not be empty`);
  assert.ok(
    statements.every((line) => /^export (?:type )?\* from '\.\/.+\.js';$/u.test(line)),
    `${relativePath} should only contain re-export statements`,
  );
}

describe('session-isolation port structure', () => {
  test('declares the initial inbound, outbound, and dto contract files', async () => {
    const expectedFiles = [
      'src/port/session-isolation/inbound/index.ts',
      'src/port/session-isolation/inbound/CreateSessionCommandPort.ts',
      'src/port/session-isolation/inbound/CloseSessionCommandPort.ts',
      'src/port/session-isolation/inbound/AbortSessionCommandPort.ts',
      'src/port/session-isolation/inbound/QuestionReplyCommandPort.ts',
      'src/port/session-isolation/inbound/PermissionReplyCommandPort.ts',
      'src/port/session-isolation/inbound/HostEventPort.ts',
      'src/port/session-isolation/outbound/index.ts',
      'src/port/session-isolation/outbound/HostSessionGateway.ts',
      'src/port/session-isolation/outbound/OwnedSessionRepository.ts',
      'src/port/session-isolation/outbound/AnchorBindingRepository.ts',
      'src/port/session-isolation/outbound/AttachOwnerRepository.ts',
      'src/port/session-isolation/outbound/SdkExecutionBridge.ts',
      'src/port/session-isolation/outbound/InteractionLookupBridge.ts',
      'src/port/session-isolation/outbound/OwnedHostEventForwarder.ts',
      'src/port/session-isolation/dto/commands/index.ts',
      'src/port/session-isolation/dto/results/index.ts',
      'src/port/session-isolation/dto/records/index.ts',
      'src/port/session-isolation/index.ts',
      'src/usecase/session-isolation/index.ts',
    ];

    await Promise.all(expectedFiles.map(assertFileExists));
  });

  test('keeps session-isolation indexes as thin re-export files', async () => {
    await Promise.all([
      assertReExportOnly('src/port/session-isolation/index.ts'),
      assertReExportOnly('src/port/session-isolation/inbound/index.ts'),
      assertReExportOnly('src/port/session-isolation/outbound/index.ts'),
      assertReExportOnly('src/port/session-isolation/dto/commands/index.ts'),
      assertReExportOnly('src/port/session-isolation/dto/results/index.ts'),
      assertReExportOnly('src/port/session-isolation/dto/records/index.ts'),
      assertReExportOnly('src/domain/session-isolation/index.ts'),
      assertReExportOnly('src/usecase/session-isolation/index.ts'),
    ]);
  });
});
