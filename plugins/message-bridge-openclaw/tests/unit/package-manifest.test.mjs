import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("source package exports runtime entry and installer subpath", async () => {
  const manifestPath = path.resolve("package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.equal(manifest.main, "bundle/index.js");
  assert.equal(manifest.exports["."].default, "./bundle/index.js");
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.equal(manifest.bin, "./scripts/install-openclaw-plugin.mjs");
  assert.equal(manifest.peerDependencies.openclaw, ">=2026.3.31");
  assert.equal(manifest.openclaw.install.minHostVersion, ">=2026.3.31");
});
