#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

/**
 * 统一准备 SDK 打包前依赖的工作区产物，避免调用方依赖手工预构建状态。
 */
export async function prepareWorkspaceDeps() {
  const buildMode = (process.env.BRIDGE_RUNTIME_SDK_BUILD_MODE ?? 'prod').trim().toLowerCase();
  const buildScript = buildMode === 'dev' ? 'build:dev' : 'build';

  await run('pnpm', ['--dir', '../skill-qrcode-auth', 'run', buildScript]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  prepareWorkspaceDeps().catch((error) => {
    console.error('[prepare-workspace-deps] failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
