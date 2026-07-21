import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { resolvePackageVersion } from '@/index.ts';

const require = createRequire(import.meta.url);
const ORIGINAL_PACKAGE_VERSION = globalThis.__MB_SDK_PACKAGE_VERSION__;

function restoreInjectedPackageVersion() {
  if (typeof ORIGINAL_PACKAGE_VERSION === 'undefined') {
    delete globalThis.__MB_SDK_PACKAGE_VERSION__;
    return;
  }

  globalThis.__MB_SDK_PACKAGE_VERSION__ = ORIGINAL_PACKAGE_VERSION;
}

test.afterEach(() => {
  restoreInjectedPackageVersion();
});

test('returns injected package version when available', () => {
  globalThis.__MB_SDK_PACKAGE_VERSION__ = '0.0.0-test';
  assert.equal(resolvePackageVersion(), '0.0.0-test');
});

test('falls back to source package version when package version is not injected', async () => {
  delete globalThis.__MB_SDK_PACKAGE_VERSION__;
  const packageJson = JSON.parse(await readFile(require.resolve('@wecode/bridge-runtime-sdk/package.json'), 'utf8'));
  assert.equal(resolvePackageVersion(), packageJson.version);
});
