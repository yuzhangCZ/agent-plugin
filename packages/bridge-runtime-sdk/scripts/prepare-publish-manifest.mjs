#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(packageDir, 'package.json');
const backupPath = path.join(packageDir, '.publish-manifest.backup.json');

function createPublishManifest(manifest) {
  return {
    ...manifest,
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      ...manifest.exports,
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    },
  };
}

async function main() {
  const source = await readFile(packageJsonPath, 'utf8');
  const manifest = JSON.parse(source);

  await writeFile(backupPath, source, 'utf8');
  await writeFile(packageJsonPath, `${JSON.stringify(createPublishManifest(manifest), null, 2)}\n`, 'utf8');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
