#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const [, , packageDirArg, refName] = process.argv;

assert.ok(packageDirArg, "usage: node scripts/assert-release-version.mjs <package-dir> <ref-name>");
assert.ok(refName, "usage: node scripts/assert-release-version.mjs <package-dir> <ref-name>");

const packageDir = path.resolve(process.cwd(), packageDirArg);
const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
const version = manifest.version;
const expectedSuffix = `/v${version}`;

assert.ok(
  refName.endsWith(expectedSuffix),
  `release tag mismatch: expected suffix ${expectedSuffix}, received ${refName}`,
);

console.log(`package_name=${manifest.name}`);
console.log(`package_version=${version}`);
