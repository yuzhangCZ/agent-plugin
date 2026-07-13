#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { prepareWorkspaceDeps } from './prepare-workspace-deps.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');

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
  const testGlobs = process.argv.slice(2);
  const nodeArgs = [
    '--import',
    './scripts/register-test-alias-loader.mjs',
    '--experimental-strip-types',
    ...(process.env.BRIDGE_RUNTIME_SDK_TEST_COVERAGE === '1' ? ['--experimental-test-coverage'] : []),
    '--test',
    ...(testGlobs.length > 0 ? testGlobs : ['tests/**/*.test.ts']),
  ];

  await run(process.execPath, nodeArgs, { cwd: packageDir });
}

main().catch((error) => {
  console.error('[test] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
