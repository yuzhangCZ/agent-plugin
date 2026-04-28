#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const distDir = path.join(packageDir, "dist");

async function rewriteFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const next = source.replace(/from "([^"]+)\.ts"/g, 'from "$1.js"');
  if (next !== source) {
    await writeFile(filePath, next, "utf8");
  }
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(target);
      continue;
    }
    if (entry.name.endsWith(".d.ts")) {
      await rewriteFile(target);
    }
  }
}

await walk(distDir);
