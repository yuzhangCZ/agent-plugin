import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("source package exports runtime entry without installer bin", async () => {
  const manifestPath = path.resolve("package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.equal(manifest.main, "bundle/index.js");
  assert.equal(manifest.exports["."].default, "./bundle/index.js");
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.equal("bin" in manifest, false);
  assert.deepEqual(manifest.files, ["bundle", "README.md", "openclaw.plugin.json"]);
  assert.equal(manifest.peerDependencies.openclaw, ">=2026.3.24");
  assert.equal(manifest.openclaw.install.minHostVersion, ">=2026.3.24");
});
