import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePluginVersion } from '../../src/runtime/pluginVersion.ts';

const ORIGINAL_PLUGIN_VERSION = globalThis.__MB_PLUGIN_VERSION__;

function restoreInjectedPluginVersion() {
  if (typeof ORIGINAL_PLUGIN_VERSION === 'undefined') {
    delete globalThis.__MB_PLUGIN_VERSION__;
    return;
  }

  globalThis.__MB_PLUGIN_VERSION__ = ORIGINAL_PLUGIN_VERSION;
}

afterEach(() => {
  restoreInjectedPluginVersion();
});

test('returns injected plugin version when available', () => {
  globalThis.__MB_PLUGIN_VERSION__ = '1.2.0-test';
  assert.equal(resolvePluginVersion(), '1.2.0-test');
});

test('falls back to unknown when build plugin version is not injected', () => {
  delete globalThis.__MB_PLUGIN_VERSION__;
  assert.equal(resolvePluginVersion(), 'unknown');
});
