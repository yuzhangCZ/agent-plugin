import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ConfigResolver } from '../../src/config/ConfigResolver.ts';

const ORIGINAL_ENV = { ...process.env };

describe('ConfigResolver debug defaults', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
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
