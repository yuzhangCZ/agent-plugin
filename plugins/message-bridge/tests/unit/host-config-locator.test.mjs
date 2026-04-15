import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import { EnvHostConfigLocator } from '../../src/config/HostConfigLocator.ts';

describe('EnvHostConfigLocator', () => {
  test('uses OPENCODE_CONFIG_DIR when present', () => {
    const locator = new EnvHostConfigLocator({
      env: {
        OPENCODE_CONFIG_DIR: '  /tmp/custom-opencode  ',
        OPENCODE_CONFIG: '/tmp/ignored/opencode.json',
      },
      homeDir: '/tmp/home',
    });

    assert.deepStrictEqual(locator.resolveUserConfigLocation(), {
      dir: '/tmp/custom-opencode',
      source: 'opencode_config_dir',
      isolationEnabled: true,
    });
  });

  test('ignores blank custom env values and falls back to default directory', () => {
    const locator = new EnvHostConfigLocator({
      env: {
        OPENCODE_CONFIG: '   ',
        OPENCODE_CONFIG_DIR: '',
      },
      homeDir: '/tmp/home',
    });

    assert.deepStrictEqual(locator.resolveUserConfigLocation(), {
      dir: join('/tmp/home', '.config', 'opencode'),
      source: 'default',
      isolationEnabled: false,
    });
  });

  test('normalizes relative custom paths', () => {
    const locator = new EnvHostConfigLocator({
      env: {
        OPENCODE_CONFIG_DIR: './tmp/opencode-config',
      },
      homeDir: '/tmp/home',
    });

    assert.deepStrictEqual(locator.resolveUserConfigLocation(), {
      dir: resolve('./tmp/opencode-config'),
      source: 'opencode_config_dir',
      isolationEnabled: true,
    });
  });

  test('does not use OPENCODE_CONFIG as bridge config root and returns a warning code', () => {
    const locator = new EnvHostConfigLocator({
      env: {
        OPENCODE_CONFIG: ' /tmp/tenant-a/opencode.jsonc ',
      },
      homeDir: '/tmp/home',
    });

    assert.deepStrictEqual(locator.resolveUserConfigLocation(), {
      dir: join('/tmp/home', '.config', 'opencode'),
      source: 'default',
      isolationEnabled: false,
      warningCode: 'opencode_config_ignored_without_config_dir',
      opencodeConfig: '/tmp/tenant-a/opencode.jsonc',
    });
  });
});
