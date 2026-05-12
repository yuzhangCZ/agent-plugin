#!/usr/bin/env node
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");
const DIST_DIR = path.join(PACKAGE_DIR, "dist");
const RELATIVE_TS_IMPORT_PATTERN =
  /((?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["'])(\.\.?\/[^"'`]+)\.ts(["'])|(import\(["'])(\.\.?\/[^"'`]+)\.ts(["']\))/g;

async function collectDeclarationFiles(rootDir) {
  const files = [];
  const entries = await readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDeclarationFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

function rewriteDeclarationImports(source) {
  return source.replace(RELATIVE_TS_IMPORT_PATTERN, (...args) => {
    if (args[1]) {
      return `${args[1]}${args[2]}.js${args[3]}`;
    }

    return `${args[4]}${args[5]}.js${args[6]}`;
  });
}

async function main() {
  const distStat = await stat(DIST_DIR).catch(() => null);
  if (!distStat?.isDirectory()) {
    throw new Error("dist directory is missing; run declaration emit before rewriting imports");
  }

  const declarationFiles = await collectDeclarationFiles(DIST_DIR);
  await Promise.all(
    declarationFiles.map(async (filePath) => {
      const current = await readFile(filePath, "utf8");
      const rewritten = rewriteDeclarationImports(current);
      if (rewritten !== current) {
        await writeFile(filePath, rewritten, "utf8");
      }
    }),
  );
}

main().catch((error) => {
  console.error("[rewrite-dts-imports] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
