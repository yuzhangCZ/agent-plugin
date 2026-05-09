#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");
const DIST_DIR = path.join(PACKAGE_DIR, "dist");
const README_PATH = path.join(PACKAGE_DIR, "README.md");

const PUBLISH_MANIFEST_KEYS = [
  "name",
  "version",
  "type",
  "bin",
  "description",
  "keywords",
  "author",
  "license",
  "homepage",
  "repository",
  "bugs",
  "funding",
  "publishConfig",
  "engines",
  "os",
  "cpu",
];

function resolveOutputDir(argv) {
  const outDirIndex = argv.findIndex((arg) => arg === "--out-dir");
  if (outDirIndex >= 0) {
    const value = argv[outDirIndex + 1];
    assert.ok(value, "missing value for --out-dir");
    return path.resolve(PACKAGE_DIR, value);
  }
  return path.join(PACKAGE_DIR, ".tmp", "release-tarball");
}

function createPublishManifest(sourceManifest) {
  const manifest = {};
  for (const key of PUBLISH_MANIFEST_KEYS) {
    if (key in sourceManifest && sourceManifest[key] !== undefined) {
      manifest[key] = sourceManifest[key];
    }
  }
  return manifest;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? PACKAGE_DIR,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.stdio ?? "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

async function main() {
  const outputDir = resolveOutputDir(process.argv.slice(2));
  const sourceManifest = JSON.parse(await readFile(path.join(PACKAGE_DIR, "package.json"), "utf8"));
  const stagingRoot = await mkdtemp(path.join(tmpdir(), "skill-plugin-cli-release-"));
  const stagingPackageDir = path.join(stagingRoot, "package");

  try {
    await mkdir(stagingPackageDir, { recursive: true });
    await cp(DIST_DIR, path.join(stagingPackageDir, "dist"), { recursive: true });
    await cp(README_PATH, path.join(stagingPackageDir, "README.md"));
    await writeFile(
      path.join(stagingPackageDir, "package.json"),
      `${JSON.stringify(createPublishManifest(sourceManifest), null, 2)}\n`,
      "utf8",
    );

    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    await run("npm", ["pack", "--pack-destination", outputDir], {
      cwd: stagingPackageDir,
      env: { npm_config_cache: path.join(stagingRoot, ".npm-cache") },
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[build-release-tarball] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
