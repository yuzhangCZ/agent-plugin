#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(repoRoot, 'integration', 'opencode-cui');

const requiredPaths = [
  '.git',
  'package.json',
  'ai-gateway',
  'skill-server',
];

function fail(message) {
  console.error(`[fixture] FAIL ${message}`);
  process.exit(1);
}

if (!existsSync(fixtureRoot)) {
  fail(`missing fixture directory: ${fixtureRoot}`);
}

for (const relativePath of requiredPaths) {
  const target = path.join(fixtureRoot, relativePath);
  if (!existsSync(target)) {
    fail(`missing required fixture path: ${relativePath}`);
  }
}

const gitDir = path.join(fixtureRoot, '.git');
if (!statSync(gitDir).isFile() && !statSync(gitDir).isDirectory()) {
  fail(`invalid git metadata in fixture: ${gitDir}`);
}

const gitHead = spawnSync('git', ['-C', fixtureRoot, 'rev-parse', '--short', 'HEAD'], {
  encoding: 'utf8',
});

if ((gitHead.status ?? 1) !== 0) {
  fail(`unable to resolve fixture HEAD: ${(gitHead.stderr || gitHead.stdout || '').trim()}`);
}

console.log('[fixture] OK');
console.log(`fixture_root=${fixtureRoot}`);
console.log(`fixture_head=${gitHead.stdout.trim()}`);
