import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadGatewayConfig, toSafeGatewayConfig } from '../src/config-loader.ts';

test('loads BridgeGatewayHostConfig from message-bridge jsonc', async () => {
  const workspaceRoot = await createWorkspace(`{
    // local debug config
    "gateway": {
      "url": "ws://localhost:8081/ws/agent",
      "channel": "opencode"
    },
    "auth": {
      "ak": "test-ak",
      "sk": "test-sk"
    }
  }`);

  const config = await loadGatewayConfig({ workspaceRoot });

  assert.deepEqual(config, {
    url: 'ws://localhost:8081/ws/agent',
    auth: {
      ak: 'test-ak',
      sk: 'test-sk',
    },
    register: {
      channel: 'opencode',
      toolVersion: 'sdk-lab',
      pluginVersion: 'sdk-lab',
    },
  });
});

test('applies safe overrides without allowing browser supplied credentials', async () => {
  const workspaceRoot = await createWorkspace(`{
    "gateway": { "url": "ws://localhost:8081/ws/agent", "channel": "opencode" },
    "auth": { "ak": "test-ak", "sk": "test-sk" }
  }`);

  const config = await loadGatewayConfig({
    workspaceRoot,
    overrides: {
      url: 'ws://localhost:9090/ws/agent',
      channel: 'sdk-lab',
      toolVersion: '2.0.0',
      pluginVersion: 'lab-plugin',
    },
  });

  assert.equal(config.url, 'ws://localhost:9090/ws/agent');
  assert.equal(config.register.channel, 'sdk-lab');
  assert.equal(config.register.toolVersion, '2.0.0');
  assert.equal(config.register.pluginVersion, 'lab-plugin');
  assert.equal(config.auth.ak, 'test-ak');
  assert.equal(config.auth.sk, 'test-sk');
});

test('returns a safe config view without auth secrets', async () => {
  const safe = toSafeGatewayConfig({
    url: 'ws://localhost:8081/ws/agent',
    auth: {
      ak: 'test-ak',
      sk: 'test-sk',
    },
    register: {
      channel: 'opencode',
      toolVersion: 'sdk-lab',
      pluginVersion: 'sdk-lab',
    },
  });

  assert.deepEqual(safe, {
    url: 'ws://localhost:8081/ws/agent',
    authLoaded: true,
    register: {
      channel: 'opencode',
      toolVersion: 'sdk-lab',
      pluginVersion: 'sdk-lab',
    },
  });
  assert.equal(JSON.stringify(safe).includes('test-sk'), false);
  assert.equal(JSON.stringify(safe).includes('test-ak'), false);
});

async function createWorkspace(configText: string): Promise<string> {
  const workspaceRoot = join(tmpdir(), `bridge-sdk-lab-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const configDir = join(workspaceRoot, '.opencode');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'message-bridge.jsonc'), configText, 'utf8');
  return workspaceRoot;
}
