#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { prepareWorkspaceDeps } from './prepare-workspace-deps.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');

function parseTestArgs(rawArgs) {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const nodeTestArgs = [];
  const testGlobs = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }

    if (arg === '--test-name-pattern' || arg === '-t') {
      const patternIndex = args[index + 1] === '--' ? index + 2 : index + 1;
      const pattern = args[patternIndex];
      if (!pattern) {
        throw new Error(`${arg} requires a pattern`);
      }
      nodeTestArgs.push('--test-name-pattern', pattern);
      index = patternIndex;
      continue;
    }

    if (arg?.startsWith('--test-name-pattern=')) {
      const pattern = arg.slice('--test-name-pattern='.length);
      if (!pattern) {
        throw new Error('--test-name-pattern requires a pattern');
      }
      nodeTestArgs.push('--test-name-pattern', pattern);
      continue;
    }

    testGlobs.push(arg);
  }

  return {
    nodeTestArgs,
    testGlobs,
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? packageDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.stdio ?? 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed with code ${code}`));
    });
  });
}

async function main() {
  await prepareWorkspaceDeps();
  const { nodeTestArgs, testGlobs } = parseTestArgs(process.argv.slice(2));
  const nodeArgs = [
    '--import',
    './scripts/register-test-alias-loader.mjs',
    '--experimental-strip-types',
    ...(process.env.BRIDGE_RUNTIME_SDK_TEST_COVERAGE === '1' ? ['--experimental-test-coverage'] : []),
    '--test',
    ...nodeTestArgs,
    ...(testGlobs.length > 0 ? testGlobs : ['tests/**/*.test.ts']),
  ];

  await run(process.execPath, nodeArgs, { cwd: packageDir });
}

main().catch((error) => {
  console.error('[test] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
