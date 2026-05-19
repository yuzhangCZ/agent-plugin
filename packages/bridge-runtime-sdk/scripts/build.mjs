#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { prepareWorkspaceDeps } from './prepare-workspace-deps.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');

function resolveExecutable(command) {
  if (process.platform !== 'win32') {
    return command;
  }

  if (command === 'pnpm' || command === 'npm' || command === 'npx') {
    return `${command}.cmd`;
  }

  return command;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const resolvedCommand = resolveExecutable(command);
    const child = spawn(resolvedCommand, args, {
      cwd: options.cwd ?? packageDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.stdio ?? 'inherit',
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedCommand),
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${resolvedCommand} ${args.join(' ')} failed with code ${code}`));
    });
  });
}

async function main() {
  const forwardedArgs = process.argv.slice(2);

  await prepareWorkspaceDeps();
  await run(process.execPath, ['./scripts/build-package.mjs', ...forwardedArgs], { cwd: packageDir });
}

main().catch((error) => {
  console.error('[build] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
