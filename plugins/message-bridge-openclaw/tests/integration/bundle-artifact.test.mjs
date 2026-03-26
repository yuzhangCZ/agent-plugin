import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

test("builds bundle-only artifact with publish metadata", async () => {
  execFileSync("node", ["./scripts/build-bundle.mjs"], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: process.env,
  });

  const bundleRoot = resolve("bundle");
  const bundleEntry = resolve("bundle/index.js");
  const bundleManifestPath = resolve("bundle/package.json");
  const bundleReadmePath = resolve("bundle/README.md");

  await access(bundleRoot, constants.R_OK);
  await access(bundleEntry, constants.R_OK);
  await access(bundleManifestPath, constants.R_OK);
  await access(bundleReadmePath, constants.R_OK);

  const manifest = JSON.parse(await readFile(bundleManifestPath, "utf8"));
  assert.equal(manifest.main, "index.js");
  assert.equal(manifest.openclaw.extensions[0], "./index.js");
  assert.equal(manifest.openclaw.install.defaultChoice, "npm");
  assert.equal(manifest.peerDependencies.openclaw, ">=2026.3.11");
});
