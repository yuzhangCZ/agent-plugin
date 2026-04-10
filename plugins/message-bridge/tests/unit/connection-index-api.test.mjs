import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as connectionApi from '../../src/connection/index.ts';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('connection index removes legacy runtime exports', () => {
  assert.strictEqual('DefaultReconnectPolicy' in connectionApi, false);
  assert.strictEqual('DefaultAkSkAuth' in connectionApi, false);
});

test('connection index type contracts reject legacy aliases', async () => {
  await assert.rejects(
    execFileAsync('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tests/type-contracts/tsconfig.connection-index-legacy-negative.json'], {
      cwd: packageRoot,
    }),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return (
        output.includes('GatewayConnection') &&
        output.includes('GatewayConnectionOptions') &&
        output.includes('GatewayConnectionEvents') &&
        output.includes('AkSkAuth')
      );
    },
  );
});
