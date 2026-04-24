#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(packageDir, 'dist');
const defaultGatewayUrl = process.env.MB_DEFAULT_GATEWAY_URL?.trim() || 'ws://localhost:8081/ws/agent';
const forbiddenSpecifiers = ['@agent-plugin/gateway-client', '@agent-plugin/gateway-schema'];
const shouldMinify = !['0', 'false', 'no', 'off'].includes((process.env.BRIDGE_RUNTIME_SDK_MINIFY ?? '1').trim().toLowerCase());

async function main() {
  const packageManifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const packageVersion = typeof packageManifest.version === 'string' ? packageManifest.version.trim() : '';
  if (!packageVersion) {
    throw new Error(`package.json version is missing: ${path.join(packageDir, 'package.json')}`);
  }

  await rm(distDir, { force: true, recursive: true });
  await mkdir(distDir, { recursive: true });

  await build({
    absWorkingDir: packageDir,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    sourcemap: false,
    minify: shouldMinify,
    define: {
      'globalThis.__MB_DEFAULT_GATEWAY_URL__': JSON.stringify(defaultGatewayUrl),
      'globalThis.__MB_PACKAGE_VERSION__': JSON.stringify(packageVersion),
    },
    external: ['node:*'],
  });

  execFileSync(
    'pnpm',
    [
      'exec',
      'dts-bundle-generator',
      '--project',
      'tsconfig.build.json',
      '--out-file',
      'dist/index.d.ts',
      'src/public-contract.ts',
    ],
    {
      cwd: packageDir,
      stdio: 'inherit',
    },
  );

  const declarations = await readFile(path.join(distDir, 'index.d.ts'), 'utf8');
  for (const specifier of forbiddenSpecifiers) {
    if (declarations.includes(specifier)) {
      throw new Error(`declaration bundle still references forbidden package specifier: ${specifier}`);
    }
  }

  await writeFile(
    path.join(distDir, 'package.json'),
    `${JSON.stringify({
      name: packageManifest.name,
      version: packageManifest.version,
      type: 'module',
      main: './index.js',
      types: './index.d.ts',
    }, null, 2)}\n`,
    'utf8',
  );

  await import(pathToFileURL(path.join(distDir, 'index.js')).href);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
