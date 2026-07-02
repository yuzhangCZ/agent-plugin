import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('BridgeEvent stays aligned with OpenCode host event contracts', async () => {
  await execFileAsync('pnpm', [
    'exec',
    'tsc',
    '--noEmit',
    '-p',
    'tests/type-contracts/tsconfig.bridge-event.json',
  ], {
    cwd: new URL('../..', import.meta.url),
  });
});
