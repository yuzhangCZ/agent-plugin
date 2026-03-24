#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const [, , packageDirArg] = process.argv;

if (!packageDirArg) {
  console.error("usage: node scripts/npm-dist-tag.mjs <package-dir>");
  process.exit(1);
}

const packageDir = path.resolve(process.cwd(), packageDirArg);
const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
const version = String(manifest.version);
const prereleaseMatch = version.match(/-(.+)$/);

if (!prereleaseMatch) {
  console.log("latest");
  process.exit(0);
}

const [identifier] = prereleaseMatch[1].split(".");
console.log(identifier || "latest");
