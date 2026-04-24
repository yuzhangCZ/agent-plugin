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
  const bundleInstallPath = resolve("bundle/install.mjs");
  const bundleManifestPath = resolve("bundle/package.json");
  const bundleReadmePath = resolve("bundle/README.md");
  const sourceManifestPath = resolve("package.json");

  await access(bundleRoot, constants.R_OK);
  await access(bundleEntry, constants.R_OK);
  await access(bundleInstallPath, constants.R_OK);
  await access(bundleManifestPath, constants.R_OK);
  await access(bundleReadmePath, constants.R_OK);

  const manifest = JSON.parse(await readFile(bundleManifestPath, "utf8"));
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  const bundleContent = await readFile(bundleEntry, "utf8");
  const installContent = await readFile(bundleInstallPath, "utf8");
  assert.equal(manifest.main, "index.js");
  assert.equal(manifest.exports["."].default, "./index.js");
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.equal(manifest.bin, "./install.mjs");
  assert.equal(manifest.openclaw.extensions[0], "./index.js");
  assert.equal(manifest.openclaw.install.defaultChoice, "npm");
  assert.equal(manifest.peerDependencies.openclaw, sourceManifest.peerDependencies.openclaw);
  assert.equal(manifest.openclaw.install.minHostVersion, sourceManifest.openclaw.install.minHostVersion);
  assert.match(bundleContent, /ws:\/\/localhost:8081\/ws\/agent/);
  assert.match(bundleContent, new RegExp(sourceManifest.version.replaceAll(".", "\\.")));
  assert.match(bundleContent, /openclaw\/plugin-sdk/);
  assert.doesNotMatch(installContent, /from "\.\/openclaw-command-resolver\.mjs"/);
  assert.match(installContent, /^#!\/usr\/bin\/env node\n/);
});

test("builds bundle artifact with injected default gateway url", async () => {
  execFileSync("node", ["./scripts/build-bundle.mjs"], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: {
      ...process.env,
      MB_DEFAULT_GATEWAY_URL: "wss://gateway.example.com/ws/agent",
    },
  });

  const bundleEntry = resolve("bundle/index.js");
  const bundleContent = await readFile(bundleEntry, "utf8");
  assert.match(bundleContent, /wss:\/\/gateway\.example\.com\/ws\/agent/);
});
