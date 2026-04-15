#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const rootDir = process.cwd();
const bundleDir = join(rootDir, "bundle");
const packDir = join(rootDir, ".tmp", "pack-check");
const npmHomeDir = join(packDir, "home");
const npmCacheDir = join(packDir, ".npm-cache");
const npmLogsDir = join(packDir, ".npm-logs");

async function readPackedManifest(tgzPath) {
  const extractedDir = await mkdtemp(join(tmpdir(), "openclaw-pack-"));
  try {
    execFileSync("tar", ["-xzf", tgzPath, "-C", extractedDir], {
      stdio: "pipe",
    });

    return JSON.parse(await readFile(join(extractedDir, "package", "package.json"), "utf8"));
  } finally {
    await rm(extractedDir, { recursive: true, force: true });
  }
}

async function main() {
  await rm(packDir, { recursive: true, force: true });
  await mkdir(packDir, { recursive: true });
  await mkdir(npmHomeDir, { recursive: true });
  await mkdir(npmCacheDir, { recursive: true });
  await mkdir(npmLogsDir, { recursive: true });

  execFileSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: bundleDir,
    stdio: "pipe",
    env: {
      ...process.env,
      HOME: npmHomeDir,
      npm_config_cache: npmCacheDir,
      npm_config_logs_dir: npmLogsDir,
    },
  });

  const tgzName = (await readdir(packDir)).find((name) => name.endsWith(".tgz"));
  assert.ok(tgzName, "pack check failed: no .tgz generated from bundle/");

  const tgzPath = join(packDir, tgzName);
  const archiveEntries = execFileSync("tar", ["-tzf", tgzPath], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  for (const entry of [
    "package/index.js",
    "package/install.mjs",
    "package/package.json",
    "package/openclaw.plugin.json",
    "package/README.md",
  ]) {
    assert.ok(archiveEntries.includes(entry), `pack check failed: ${entry} missing in tarball`);
  }

  assert.ok(
    !archiveEntries.some((entry) => entry.startsWith("package/dist/")),
    "pack check failed: tarball must not include dist/",
  );
  assert.ok(
    !archiveEntries.some((entry) => entry.startsWith("package/docs/")),
    "pack check failed: tarball must not include docs/",
  );
  assert.ok(
    !archiveEntries.some((entry) => entry.endsWith(".map")),
    "pack check failed: tarball must not include sourcemap",
  );

  const manifest = await readPackedManifest(tgzPath);
  assert.equal(manifest.name, "@wecode/skill-openclaw-plugin", "pack check failed: unexpected package name");
  assert.equal(manifest.main, "index.js", "pack check failed: main must point to bundle root");
  assert.equal(
    manifest.bin?.["message-bridge-openclaw-install"],
    "./install.mjs",
    "pack check failed: bin must point to install.mjs",
  );

  console.log("Pack check passed: bundle-only artifact, no docs, no dist, no sourcemap.");
}

main().catch((error) => {
  console.error("[check-pack] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
