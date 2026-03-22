#!/usr/bin/env node
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const PACK_DIR = join(process.cwd(), '.tmp', 'pack-check');

async function main() {
  await rm(PACK_DIR, { recursive: true, force: true });
  await mkdir(PACK_DIR, { recursive: true });
}

main().catch((error) => {
  console.error('[prepare-pack-check] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
