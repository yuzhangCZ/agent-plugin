import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const PACKAGE_NAME = '@wecode/skill-opencode-plugin';

function createPluginClient(overrides = {}) {
  const base = {
    global: {},
    app: {},
    session: {
      create: async () => ({}),
      get: async () => ({}),
      abort: async () => ({}),
      delete: async () => ({}),
      prompt: async () => ({}),
    },
    postSessionIdPermissionsPermissionId: async () => ({}),
    _client: {
      get: async (options) => {
        if (options?.url === '/global/health') {
          return { data: { healthy: true, version: '9.9.9' } };
        }
        return { data: [] };
      },
      post: async () => ({ data: undefined }),
    },
  };

  return {
    ...base,
    ...overrides,
    global: { ...base.global, ...(overrides.global ?? {}) },
    app: { ...base.app, ...(overrides.app ?? {}) },
    session: { ...base.session, ...(overrides.session ?? {}) },
    _client: { ...base._client, ...(overrides._client ?? {}) },
  };
}

function mockInput(overrides = {}) {
  return {
    client: {},
    project: {},
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL('http://localhost:4096'),
    $: {},
    ...overrides,
  };
}

async function importArtifact(cacheKey) {
  const artifactPath = resolve('release/message-bridge.plugin.js');
  return import(`${pathToFileURL(artifactPath).href}?cache=${cacheKey}`);
}

async function readPackageVersion() {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.strictEqual(typeof packageJson.version, 'string');
  return packageJson.version;
}

describe('plugin distribution artifact', () => {
  test('builds prod artifact without sourcemap and with default and named exports', async () => {
    const pluginVersion = await readPackageVersion();
    execFileSync('node', ['./scripts/build.mjs'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: process.env,
    });

    const artifactPath = resolve('release/message-bridge.plugin.js');
    const sourcemapPath = resolve('release/message-bridge.plugin.js.map');
    await access(artifactPath, constants.R_OK);
    await assert.rejects(access(sourcemapPath, constants.R_OK));
    const artifactContent = await readFile(artifactPath, 'utf8');
    assert.match(artifactContent, /ws:\/\/localhost:8081\/ws\/agent/);
    assert.match(artifactContent, new RegExp(pluginVersion.replaceAll('.', '\\.')));

    const mod = await importArtifact('prod-exports');

    assert.strictEqual(typeof mod.default, 'function');
    assert.strictEqual(typeof mod.MessageBridgePlugin, 'function');
    assert.strictEqual(typeof mod.getMessageBridgeStatus, 'function');
    assert.strictEqual(typeof mod.subscribeMessageBridgeStatus, 'function');
    assert.strictEqual(mod.default, mod.MessageBridgePlugin);
  });

  test('builds artifact with injected default gateway url', async () => {
    execFileSync('node', ['./scripts/build.mjs'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: {
        ...process.env,
        MB_DEFAULT_GATEWAY_URL: 'wss://gateway.example.com/ws/agent',
      },
    });

    const artifactPath = resolve('release/message-bridge.plugin.js');
    const artifactContent = await readFile(artifactPath, 'utf8');
    assert.match(artifactContent, /wss:\/\/gateway\.example\.com\/ws\/agent/);
  });

  test('falls back to default-config chain when MB_DEFAULT_GATEWAY_URL is blank', async () => {
    execFileSync('node', ['./scripts/build.mjs'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: {
        ...process.env,
        MB_DEFAULT_GATEWAY_URL: '   ',
      },
    });

    const artifactPath = resolve('release/message-bridge.plugin.js');
    const artifactContent = await readFile(artifactPath, 'utf8');
    assert.match(artifactContent, /ws:\/\/localhost:8081\/ws\/agent/);
    assert.doesNotMatch(artifactContent, /globalThis\.__MB_DEFAULT_GATEWAY_URL__="\s+"/);
  });

  test('builds dev artifact with sourcemap', async () => {
    execFileSync('node', ['./scripts/build-plugin.mjs', '--mode=dev'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: process.env,
    });

    const artifactPath = resolve('release/message-bridge.plugin.js');
    const sourcemapPath = resolve('release/message-bridge.plugin.js.map');
    await access(artifactPath, constants.R_OK);
    await access(sourcemapPath, constants.R_OK);

    const mod = await importArtifact('dev-exports');
    assert.strictEqual(typeof mod.default, 'function');
    assert.strictEqual(typeof mod.MessageBridgePlugin, 'function');
    assert.strictEqual(typeof mod.getMessageBridgeStatus, 'function');
    assert.strictEqual(typeof mod.subscribeMessageBridgeStatus, 'function');
    assert.strictEqual(mod.default, mod.MessageBridgePlugin);
  });

  test('built artifact logs injected plugin version during runtime start', async () => {
    const pluginVersion = await readPackageVersion();
    const originalBridgeEnabled = process.env.BRIDGE_ENABLED;
    process.env.BRIDGE_ENABLED = 'false';

    try {
      execFileSync('node', ['./scripts/build.mjs'], {
        cwd: process.cwd(),
        stdio: 'pipe',
        env: process.env,
      });

      const logs = [];
      const mod = await importArtifact('prod-runtime-log');
      await mod.MessageBridgePlugin(
        mockInput({
          client: createPluginClient({
            app: {
              log: async (options) => {
                logs.push(options?.body);
                return true;
              },
            },
          }),
        }),
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));

      const startLog = logs.find((entry) => entry?.message === 'runtime.start.requested');
      assert.ok(startLog);
      assert.strictEqual(startLog.extra.pluginVersion, pluginVersion);
      assert.notStrictEqual(startLog.extra.pluginVersion, 'unknown');
    } finally {
      if (originalBridgeEnabled === undefined) {
        delete process.env.BRIDGE_ENABLED;
      } else {
        process.env.BRIDGE_ENABLED = originalBridgeEnabled;
      }
    }
  });

  test('builds package entrypoint for Node package loading (opencode npm load path)', async () => {
    execFileSync('node', ['./scripts/build.mjs'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: process.env,
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'message-bridge-package-'));
    try {
      const packageScopeDir = join(tempDir, 'node_modules', '@wecode');
      await mkdir(packageScopeDir, { recursive: true });
      await symlink(process.cwd(), join(packageScopeDir, 'skill-opencode-plugin'), process.platform === 'win32' ? 'junction' : 'dir');

      const stdout = execFileSync(
        process.execPath,
        [
          '-e',
          `import(${JSON.stringify(PACKAGE_NAME)}).then(mod => { console.log(typeof mod.default, typeof mod.MessageBridgePlugin, typeof mod.getMessageBridgeStatus, typeof mod.subscribeMessageBridgeStatus, mod.default === mod.MessageBridgePlugin); })`,
        ],
        {
          cwd: tempDir,
          stdio: 'pipe',
          env: process.env,
        },
      ).toString().trim();

      assert.strictEqual(stdout, 'function function function function true');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
