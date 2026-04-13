import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('public api positive type fixture compiles with stable entry exports', async () => {
  await assert.doesNotReject(async () => {
    await execFileAsync('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tests/type-contracts/tsconfig.positive.json'], {
      cwd: packageRoot,
    });
  });
});

test('public api negative type fixture rejects importing overrides from stable entry', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gateway-client-contract-'));
  const tempFixture = path.join(tempDir, 'public-api-negative-overrides.ts');
  writeFileSync(
    tempFixture,
    `import type { GatewayClientOverrides } from ${JSON.stringify(path.resolve(packageRoot, 'src/index.ts'))};\n\nconst _overrides: GatewayClientOverrides = {};\n`,
  );

  await assert.rejects(
    execFileAsync(
      'pnpm',
      [
        'exec',
        'tsc',
        '--noEmit',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--strict',
        '--allowImportingTsExtensions',
        '--types',
        'node',
        tempFixture,
      ],
      {
        cwd: packageRoot,
      },
    ),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return output.includes('GatewayClientOverrides');
    },
  );
});

test('public api negative type fixture rejects control frames in send payload', async () => {
  await assert.rejects(
    execFileAsync('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tests/type-contracts/tsconfig.negative.json'], {
      cwd: packageRoot,
    }),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return output.includes('heartbeat');
    },
  );
});

test('public api negative type fixture rejects importing config assembly helper from stable entry', async () => {
  await assert.rejects(
    execFileAsync('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tests/type-contracts/tsconfig.negative-assemble.json'], {
      cwd: packageRoot,
    }),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return output.includes('assembleGatewayClientConfig');
    },
  );
});
