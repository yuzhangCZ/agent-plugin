#!/usr/bin/env node
import { rm, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const ROOT_DIR = process.cwd();
const RELEASE_DIR = path.join(ROOT_DIR, 'release');
const OUTFILE = path.join(RELEASE_DIR, 'message-bridge.plugin.js');

function resolveBuildMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : 'prod';
  if (mode !== 'prod' && mode !== 'dev') {
    throw new Error(`invalid build mode: ${mode}. expected prod or dev`);
  }
  return mode;
}

async function main() {
  const mode = resolveBuildMode(process.argv.slice(2));
  await rm(RELEASE_DIR, { recursive: true, force: true });
  await mkdir(RELEASE_DIR, { recursive: true });

  await build({
    bundle: true,
    entryPoints: ['src/index.ts'],
    format: 'esm',
    mainFields: ['module', 'main'],
    outfile: OUTFILE,
    platform: 'node',
    minify: mode === 'prod',
    sourcemap: mode === 'dev',
  });

  await access(OUTFILE, constants.R_OK);

  console.log('Built plugin distribution artifact:');
  console.log(`- ${OUTFILE}`);
  console.log(`- mode: ${mode}`);
  console.log('Compatibility install path: copy the file into .opencode/plugins if package loading is unavailable.');
}

main().catch((err) => {
  console.error('[build-release] failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
