import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { resolvePackageVersion } from '@/packageVersion.ts';

test('test runner resolves @ alias to bridge-runtime-sdk src', () => {
  assert.equal(typeof resolvePackageVersion, 'function');
});

test('typescript config declares @ alias for src imports', async () => {
  const tsconfig = JSON.parse(await readFile(new URL('../../tsconfig.json', import.meta.url), 'utf8'));

  assert.equal(tsconfig.compilerOptions.baseUrl, '.');
  assert.deepEqual(tsconfig.compilerOptions.paths, {
    '@/*': ['src/*'],
  });
});

test('test script registers @ alias loader before running node tests', async () => {
  const testScript = await readFile(new URL('../../scripts/test.mjs', import.meta.url), 'utf8');

  assert.equal(testScript.includes('--import'), true);
  assert.equal(testScript.includes('./scripts/register-test-alias-loader.mjs'), true);
});

test('package exposes unit-only test scripts', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { scripts?: Record<string, string> };

  assert.equal(packageJson.scripts?.['test:file'], undefined);
  assert.match(packageJson.scripts?.['test:case'] ?? '', /--test-name-pattern/);
  assert.match(packageJson.scripts?.['test:unit'] ?? '', /tests\/unit\/\*\*\/\*\.test\.ts/);
  assert.match(packageJson.scripts?.['coverage:unit'] ?? '', /BRIDGE_RUNTIME_SDK_TEST_COVERAGE=1/);
});

test('test runner accepts explicit test globs, test name pattern, and optional coverage flag', async () => {
  const testScript = await readFile(new URL('../../scripts/test.mjs', import.meta.url), 'utf8');

  assert.match(testScript, /process\.argv\.slice\(2\)/);
  assert.match(testScript, /--test-name-pattern/);
  assert.match(testScript, /BRIDGE_RUNTIME_SDK_TEST_COVERAGE/);
});

test('build script rejects @ alias leakage in declaration bundle', async () => {
  const buildScript = await readFile(new URL('../../scripts/build-package.mjs', import.meta.url), 'utf8');

  assert.equal(buildScript.includes("'@/'"), true);
});
