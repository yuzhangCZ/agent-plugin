import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePackageVersion } from '../src/index.ts';

const ORIGINAL_PACKAGE_VERSION = globalThis.__MB_PACKAGE_VERSION__;

function restoreInjectedPackageVersion() {
  if (typeof ORIGINAL_PACKAGE_VERSION === 'undefined') {
    delete globalThis.__MB_PACKAGE_VERSION__;
    return;
  }

  globalThis.__MB_PACKAGE_VERSION__ = ORIGINAL_PACKAGE_VERSION;
}

test.afterEach(() => {
  restoreInjectedPackageVersion();
});

test('returns injected package version when available', () => {
  globalThis.__MB_PACKAGE_VERSION__ = '0.0.0-test';
  assert.equal(resolvePackageVersion(), '0.0.0-test');
});

test('falls back to unknown when package version is not injected', () => {
  delete globalThis.__MB_PACKAGE_VERSION__;
  assert.equal(resolvePackageVersion(), 'unknown');
});
