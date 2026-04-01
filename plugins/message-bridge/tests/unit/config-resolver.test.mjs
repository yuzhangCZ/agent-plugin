import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';

import { ConfigResolver } from '../../src/config/ConfigResolver.ts';
import { DEFAULT_BRIDGE_CONFIG } from '../../src/config/default-config.ts';

const ORIGINAL_ENV = { ...process.env };

describe('ConfigResolver debug defaults', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('inherits defaults from default-config without normalize fallbacks', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'message-bridge-config-'));
    process.env.HOME = tempHome;
    try {
      const config = await new ConfigResolver().resolveConfig(tempHome);
      assert.deepStrictEqual(config.gateway, DEFAULT_BRIDGE_CONFIG.gateway);
      assert.strictEqual(config.gateway.reconnect.jitter, 'full');
      assert.strictEqual(config.gateway.reconnect.maxElapsedMs, 600000);
      assert.deepStrictEqual(config.sdk, DEFAULT_BRIDGE_CONFIG.sdk);
      assert.deepStrictEqual(config.events, DEFAULT_BRIDGE_CONFIG.events);
      assert.strictEqual(config.enabled, DEFAULT_BRIDGE_CONFIG.enabled);
      assert.strictEqual(config.config_version, DEFAULT_BRIDGE_CONFIG.config_version);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('inherits missing fields from default-config during merge', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'message-bridge-config-'));
    process.env.HOME = tempHome;
    try {
      await mkdir(join(tempHome, '.opencode'), { recursive: true });
      await writeFile(
        join(tempHome, '.opencode', 'message-bridge.json'),
        JSON.stringify({
          auth: {
            ak: 'custom-ak',
            sk: 'custom-sk',
          },
          gateway: {
            channel: ' uniassistant ',
          },
        }),
        'utf8',
      );

      const config = await new ConfigResolver().resolveConfig(tempHome);
      assert.strictEqual(config.gateway.url, DEFAULT_BRIDGE_CONFIG.gateway.url);
      assert.strictEqual(config.gateway.channel, 'uniassistant');
      assert.deepStrictEqual(config.gateway.reconnect, DEFAULT_BRIDGE_CONFIG.gateway.reconnect);
      assert.deepStrictEqual(config.sdk, DEFAULT_BRIDGE_CONFIG.sdk);
      assert.deepStrictEqual(config.events, DEFAULT_BRIDGE_CONFIG.events);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('keeps debug disabled by default', async () => {
    delete process.env.BRIDGE_DEBUG;
    const tempHome = await mkdtemp(join(tmpdir(), 'message-bridge-config-'));
    process.env.HOME = tempHome;
    try {
      const config = await new ConfigResolver().resolveConfig(tempHome);
      assert.strictEqual(config.debug, false);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('enables debug when BRIDGE_DEBUG=true', async () => {
    process.env.BRIDGE_DEBUG = 'true';
    const tempHome = await mkdtemp(join(tmpdir(), 'message-bridge-config-'));
    process.env.HOME = tempHome;
    try {
      const config = await new ConfigResolver().resolveConfig(tempHome);
      assert.strictEqual(config.debug, true);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test('loads user config from OPENCODE_CONFIG_DIR', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'message-bridge-config-'));
    const configRoot = await mkdtemp(join(tmpdir(), 'message-bridge-custom-config-'));
    process.env.HOME = tempHome;
    process.env.OPENCODE_CONFIG_DIR = configRoot;
    try {
      await writeFile(
        join(configRoot, 'message-bridge.json'),
        JSON.stringify({
          auth: {
            ak: 'custom-dir-ak',
            sk: 'custom-dir-sk',
          },
        }),
        'utf8',
      );

      const config = await new ConfigResolver().resolveConfig(tempHome);
      assert.strictEqual(config.auth.ak, 'custom-dir-ak');
      assert.strictEqual(config.auth.sk, 'custom-dir-sk');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  test('ignores OPENCODE_CONFIG for bridge config lookup', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'message-bridge-config-'));
    const defaultRoot = join(tempHome, '.config', 'opencode');
    const configRoot = await mkdtemp(join(tmpdir(), 'message-bridge-custom-config-'));
    process.env.HOME = tempHome;
    process.env.OPENCODE_CONFIG = join(configRoot, 'opencode.jsonc');
    try {
      await mkdir(defaultRoot, { recursive: true });
      await writeFile(
        join(defaultRoot, 'message-bridge.json'),
        JSON.stringify({
          auth: {
            ak: 'default-file-ak',
            sk: 'default-file-sk',
          },
        }),
        'utf8',
      );
      await writeFile(
        join(configRoot, 'message-bridge.json'),
        JSON.stringify({
          auth: {
            ak: 'custom-file-ak',
            sk: 'custom-file-sk',
          },
        }),
        'utf8',
      );

      const config = await new ConfigResolver().resolveConfig(tempHome);
      assert.strictEqual(config.auth.ak, 'default-file-ak');
      assert.strictEqual(config.auth.sk, 'default-file-sk');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  test('prefers OPENCODE_CONFIG_DIR over default directory even when OPENCODE_CONFIG is set', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'message-bridge-config-'));
    const preferredRoot = await mkdtemp(join(tmpdir(), 'message-bridge-custom-dir-'));
    const fallbackRoot = await mkdtemp(join(tmpdir(), 'message-bridge-custom-file-'));
    process.env.HOME = tempHome;
    process.env.OPENCODE_CONFIG_DIR = preferredRoot;
    process.env.OPENCODE_CONFIG = join(fallbackRoot, 'opencode.json');
    try {
      await mkdir(join(tempHome, '.config', 'opencode'), { recursive: true });
      await writeFile(
        join(tempHome, '.config', 'opencode', 'message-bridge.json'),
        JSON.stringify({
          auth: {
            ak: 'default-ak',
            sk: 'default-sk',
          },
        }),
        'utf8',
      );
      await writeFile(
        join(preferredRoot, 'message-bridge.json'),
        JSON.stringify({
          auth: {
            ak: 'preferred-ak',
            sk: 'preferred-sk',
          },
        }),
        'utf8',
      );
      await writeFile(
        join(fallbackRoot, 'message-bridge.json'),
        JSON.stringify({
          auth: {
            ak: 'fallback-ak',
            sk: 'fallback-sk',
          },
        }),
        'utf8',
      );

      const config = await new ConfigResolver().resolveConfig(tempHome);
      assert.strictEqual(config.auth.ak, 'preferred-ak');
      assert.strictEqual(config.auth.sk, 'preferred-sk');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      await rm(preferredRoot, { recursive: true, force: true });
      await rm(fallbackRoot, { recursive: true, force: true });
    }
  });

  test('prefers message-bridge.jsonc over message-bridge.json inside OPENCODE_CONFIG_DIR', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'message-bridge-config-'));
    const configRoot = await mkdtemp(join(tmpdir(), 'message-bridge-custom-config-'));
    process.env.HOME = tempHome;
    process.env.OPENCODE_CONFIG_DIR = configRoot;
    try {
      await writeFile(
        join(configRoot, 'message-bridge.json'),
        JSON.stringify({
          auth: {
            ak: 'json-ak',
            sk: 'json-sk',
          },
        }),
        'utf8',
      );
      await writeFile(
        join(configRoot, 'message-bridge.jsonc'),
        JSON.stringify({
          auth: {
            ak: 'jsonc-ak',
            sk: 'jsonc-sk',
          },
        }),
        'utf8',
      );

      const config = await new ConfigResolver().resolveConfig(tempHome);
      assert.strictEqual(config.auth.ak, 'jsonc-ak');
      assert.strictEqual(config.auth.sk, 'jsonc-sk');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  test('parses reconnect jitter and max elapsed from environment', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'message-bridge-config-'));
    process.env.HOME = tempHome;
    process.env.BRIDGE_GATEWAY_RECONNECT_JITTER = 'none';
    process.env.BRIDGE_GATEWAY_RECONNECT_MAX_ELAPSED_MS = '12345';
    try {
      const config = await new ConfigResolver().resolveConfig(tempHome);
      assert.strictEqual(config.gateway.reconnect.jitter, 'none');
      assert.strictEqual(config.gateway.reconnect.maxElapsedMs, 12345);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      delete process.env.BRIDGE_GATEWAY_RECONNECT_JITTER;
      delete process.env.BRIDGE_GATEWAY_RECONNECT_MAX_ELAPSED_MS;
    }
  });
});
