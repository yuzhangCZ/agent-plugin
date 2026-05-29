#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';

const SOURCE_FILE_PATTERN = /\.(?:cjs|js|mjs|ts)$/u;
const SOURCE_ROOTS = ['plugins/', 'packages/', 'scripts/'];

function parseArgs(argv) {
  const options = {
    base: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') {
      options.base = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }

  return options;
}

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function listChangedFiles(options) {
  const baseRef = options.base ?? 'origin/main';
  return runGit(['diff', '--name-only', '--diff-filter=ACMRT', `${baseRef}...HEAD`]);
}

function isLintableSource(filePath) {
  return SOURCE_ROOTS.some((root) => filePath.startsWith(root)) && SOURCE_FILE_PATTERN.test(filePath);
}

function runEslint(files) {
  if (files.length === 0) {
    console.log('No changed lintable files under plugins/, packages/, or scripts/.');
    return 0;
  }

  console.log(`Linting ${files.length} changed file(s):`);
  for (const file of files) {
    console.log(`- ${relative(process.cwd(), file)}`);
  }

  const result = spawnSync('pnpm', ['exec', 'eslint', '--max-warnings=0', ...files], {
    stdio: 'inherit',
  });

  return result.status ?? 1;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const files = listChangedFiles(options).filter(isLintableSource);
  process.exit(runEslint(files));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
