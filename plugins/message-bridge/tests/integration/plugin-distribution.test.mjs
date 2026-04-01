import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const PACKAGE_NAME = '@wecode/skill-opencode-plugin';

describe('plugin distribution artifact', () => {
  test('builds prod artifact without sourcemap and with default and named exports', async () => {
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

    const mod = await import(pathToFileURL(artifactPath).href);

    assert.strictEqual(typeof mod.default, 'function');
    assert.strictEqual(typeof mod.MessageBridgePlugin, 'function');
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

    const mod = await import(pathToFileURL(artifactPath).href);
    assert.strictEqual(typeof mod.default, 'function');
    assert.strictEqual(typeof mod.MessageBridgePlugin, 'function');
    assert.strictEqual(mod.default, mod.MessageBridgePlugin);
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
          `import(${JSON.stringify(PACKAGE_NAME)}).then(mod => { console.log(typeof mod.default, typeof mod.MessageBridgePlugin, mod.default === mod.MessageBridgePlugin); })`,
        ],
        {
          cwd: tempDir,
          stdio: 'pipe',
          env: process.env,
        },
      ).toString().trim();

      assert.strictEqual(stdout, 'function function true');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
