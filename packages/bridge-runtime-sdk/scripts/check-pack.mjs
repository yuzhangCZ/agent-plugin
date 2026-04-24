#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parsePackJson(output) {
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

async function main() {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'bridge-runtime-sdk-pack-'));
  const distDir = path.join(packageDir, 'dist');
  const npmCacheDir = path.join(tmpDir, '.npm-cache');
  const buildEnv = { ...process.env };

  try {
    const sourcePackageJson = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));

    execFileSync('node', ['./scripts/build-package.mjs'], {
      cwd: packageDir,
      stdio: 'inherit',
      env: buildEnv,
    });

    const declarations = await readFile(path.join(distDir, 'index.d.ts'), 'utf8');
    assert.equal(declarations.includes('@agent-plugin/gateway-client'), false);
    assert.equal(declarations.includes('@agent-plugin/gateway-schema'), false);

    const builtSdk = await import(pathToFileURL(path.join(distDir, 'index.js')).href);
    assert.equal(typeof builtSdk.createBridgeRuntime, 'function');
    assert.equal(typeof builtSdk.resolvePackageVersion, 'function');
    assert.equal(builtSdk.resolvePackageVersion(), sourcePackageJson.version);

    const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', tmpDir], {
      cwd: packageDir,
      encoding: 'utf8',
      env: {
        ...buildEnv,
        npm_config_cache: npmCacheDir,
      },
    });
    const manifest = parsePackJson(packOutput);
    const tarballPath = path.join(tmpDir, manifest.filename);
    const entries = execFileSync('tar', ['-tf', tarballPath], {
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .filter(Boolean);

    assert(entries.includes('package/dist/index.js'));
    assert(entries.includes('package/dist/index.d.ts'));
    assert(entries.includes('package/package.json'));
    assert(entries.every((entry) => !entry.startsWith('package/src/')));

    const packedManifest = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
      encoding: 'utf8',
    });
    const pkg = JSON.parse(packedManifest);
    const runtimeDeps = Object.keys(pkg.dependencies ?? {});

    assert.equal(pkg.main, './dist/index.js');
    assert.equal(pkg.types, './dist/index.d.ts');
    assert.deepEqual(pkg.exports?.['.'], {
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
    assert.equal(runtimeDeps.includes('@agent-plugin/gateway-client'), false);
    assert.equal(runtimeDeps.includes('@agent-plugin/gateway-schema'), false);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
