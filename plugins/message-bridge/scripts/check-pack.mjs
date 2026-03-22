#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const PACK_DIR = join(process.cwd(), '.tmp', 'pack-check');

async function readPackedManifest(tgzPath) {
  const extractedDir = await mkdtemp(join(tmpdir(), 'mb-pack-'));
  try {
    execFileSync('tar', ['-xzf', tgzPath, '-C', extractedDir], {
      stdio: 'pipe',
    });

    const manifestPath = join(extractedDir, 'package', 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    return manifest;
  } finally {
    await rm(extractedDir, { recursive: true, force: true });
  }
}

async function main() {
  const files = await readdir(PACK_DIR);
  const tgzName = files.find((name) => name.endsWith('.tgz'));
  assert.ok(tgzName, 'pack check failed: no .tgz generated');

  const tgzPath = join(PACK_DIR, tgzName);
  const archiveEntries = execFileSync('tar', ['-tzf', tgzPath], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

  assert.ok(
    archiveEntries.includes('package/release/message-bridge.plugin.js'),
    'pack check failed: release/message-bridge.plugin.js missing in tarball',
  );
  assert.ok(
    !archiveEntries.some((entry) => entry.startsWith('package/dist/')),
    'pack check failed: tarball must not include dist/',
  );
  assert.ok(
    !archiveEntries.some((entry) => entry.endsWith('.map')),
    'pack check failed: tarball must not include sourcemap',
  );

  const manifest = await readPackedManifest(tgzPath);
  const dependencies = manifest.dependencies;
  const dependencyCount =
    dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)
      ? Object.keys(dependencies).length
      : 0;
  assert.equal(
    dependencyCount,
    0,
    `pack check failed: dependencies must be empty, got ${dependencyCount}`,
  );

  console.log('Pack check passed: release-only artifact, no sourcemap, zero runtime dependencies.');
}

main().catch((error) => {
  console.error('[check-pack] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
