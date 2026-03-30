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
});
