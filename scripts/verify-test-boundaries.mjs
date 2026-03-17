#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const pluginsDir = path.join(rootDir, 'plugins');
const packagesDir = path.join(rootDir, 'packages');
const forbiddenPatterns = [
  '@agent-plugin/test-support',
  'packages/test-support',
];
const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx']);
const violations = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath);
      continue;
    }
    if (!sourceExtensions.has(path.extname(entry.name))) {
      continue;
    }
    const content = await readFile(fullPath, 'utf8');
    for (const pattern of forbiddenPatterns) {
      if (content.includes(pattern)) {
        violations.push({ file: path.relative(rootDir, fullPath), pattern });
      }
    }
  }
}

async function main() {
  const productionRoots = [];

  const pluginEntries = await readdir(pluginsDir, { withFileTypes: true });
  for (const entry of pluginEntries) {
    if (!entry.isDirectory()) continue;
    productionRoots.push(path.join(pluginsDir, entry.name, 'src'));
  }

  try {
    const packageEntries = await readdir(packagesDir, { withFileTypes: true });
    for (const entry of packageEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'test-support') continue;
      productionRoots.push(path.join(packagesDir, entry.name, 'src'));
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  for (const srcDir of productionRoots) {
    try {
      await walk(srcDir);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`forbidden test-support import in ${violation.file}: ${violation.pattern}`);
    }
    process.exit(1);
  }

  console.log('verify:test-boundaries passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
