import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
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
  await assert.rejects(
    execFileAsync('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tests/type-contracts/tsconfig.negative.json'], {
      cwd: packageRoot,
    }),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return output.includes('GatewayClientOverrides');
    },
  );
});

test('legacy api negative type fixture rejects internal override fields', async () => {
  await assert.rejects(
    execFileAsync('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tests/type-contracts/tsconfig.legacy-negative.json'], {
      cwd: packageRoot,
    }),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return output.includes('webSocketFactory');
    },
  );
});
