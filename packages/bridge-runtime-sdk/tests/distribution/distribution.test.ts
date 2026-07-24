import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qrcodeDistRoot = path.resolve(packageRoot, '../skill-qrcode-auth/dist');

function runScript(script: string, env: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync('pnpm', ['run', script], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('build:dev prepares qrcode auth dependency with dev dist artifacts', { concurrency: false }, async () => {
  runScript('build:dev');

  await access(path.join(qrcodeDistRoot, 'index.js'));
  await access(path.join(qrcodeDistRoot, 'index.d.ts'));
  await access(path.join(qrcodeDistRoot, 'index.js.map'));
});

test('prod build with minify disabled still prepares prod qrcode auth artifacts', { concurrency: false }, async () => {
  runScript('build', { BRIDGE_RUNTIME_SDK_MINIFY: '0' });

  await access(path.join(qrcodeDistRoot, 'index.js'));
  await access(path.join(qrcodeDistRoot, 'index.d.ts'));
  await assert.rejects(access(path.join(qrcodeDistRoot, 'index.js.map')));

  const declarations = await readFile(path.join(packageRoot, 'dist/index.d.ts'), 'utf8');
  assert.match(declarations, /qrcodeAuth/);
  assert.match(declarations, /QrCodeAssistantInfo/);
  assert.doesNotMatch(declarations, /@wecode\/skill-qrcode-auth/);
});
