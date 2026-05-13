#!/usr/bin/env node
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(packageDir, 'package.json');
const backupPath = path.join(packageDir, '.publish-manifest.backup.json');

async function main() {
  const backup = await readFile(backupPath, 'utf8');
  await writeFile(packageJsonPath, backup, 'utf8');
  await rm(backupPath, { force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
