import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildNextNpmrcContent,
  preflightOpenClaw,
  resolveRegistryValue,
  resolveUserNpmrcPath,
} from "../../scripts/install-openclaw-plugin.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-install-unit-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createFakeOpenclaw({ version = "2026.3.24", exitCode = 0 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-openclaw-unit-"));
  const scriptPath = path.join(dir, "fake-openclaw.mjs");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write(${JSON.stringify(version)});
  process.exit(${exitCode});
}
process.exit(0);
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return {
    dir,
    scriptPath,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("preflightOpenClaw fails fast when command does not exist", async () => {
  await assert.rejects(
    preflightOpenClaw({
      openclawBin: path.join(tmpdir(), "missing-openclaw"),
      requiredRange: ">=2026.3.24 <2026.3.31",
    }),
    (error) => error?.code === "OPENCLAW_NOT_FOUND",
  );
});

test("preflightOpenClaw rejects versions below required range", async () => {
  const fake = await createFakeOpenclaw({ version: "2026.3.10" });
  try {
    await assert.rejects(
      preflightOpenClaw({
        openclawBin: fake.scriptPath,
        requiredRange: ">=2026.3.24 <2026.3.31",
      }),
      (error) => error?.code === "OPENCLAW_VERSION_UNSUPPORTED",
    );
  } finally {
    await fake.cleanup();
  }
});

test("preflightOpenClaw rejects versions above install-supported range", async () => {
  const fake = await createFakeOpenclaw({ version: "2026.3.31" });
  try {
    await assert.rejects(
      preflightOpenClaw({
        openclawBin: fake.scriptPath,
        requiredRange: ">=2026.3.24 <2026.3.31",
      }),
      (error) => error?.code === "OPENCLAW_VERSION_UNSUPPORTED",
    );
  } finally {
    await fake.cleanup();
  }
});

test("resolveRegistryValue prefers explicit registry sources before existing npmrc", () => {
  assert.equal(
    resolveRegistryValue({
      cliRegistry: "https://cli.registry/",
      envRegistry: "https://env.registry/",
      npmrcContent: "@wecode:registry=https://existing.registry/\n",
    }),
    "https://cli.registry/",
  );
  assert.equal(
    resolveRegistryValue({
      cliRegistry: "",
      envRegistry: "https://env.registry/",
      npmrcContent: "@wecode:registry=https://existing.registry/\n",
    }),
    "https://env.registry/",
  );
  assert.equal(
    resolveRegistryValue({
      cliRegistry: "https://cli.registry/",
      envRegistry: "https://env.registry/",
      npmrcContent: "",
    }),
    "https://cli.registry/",
  );
  assert.equal(
    resolveRegistryValue({
      cliRegistry: "",
      envRegistry: "https://env.registry/",
      npmrcContent: "",
    }),
    "https://env.registry/",
  );
});

test("buildNextNpmrcContent appends missing scope and updates existing scope when registry changes", () => {
  assert.equal(
    buildNextNpmrcContent(null, "https://npm.example.com"),
    "@wecode:registry=https://npm.example.com\n",
  );
  assert.equal(
    buildNextNpmrcContent("registry=https://registry.npmjs.org/\n", "https://npm.example.com"),
    "registry=https://registry.npmjs.org/\n@wecode:registry=https://npm.example.com\n",
  );
  assert.equal(
    buildNextNpmrcContent("@wecode:registry=https://existing.registry/\n", "https://npm.example.com"),
    "@wecode:registry=https://npm.example.com\n",
  );
  assert.equal(
    buildNextNpmrcContent("@wecode:registry=https://npm.example.com\n", "https://npm.example.com"),
    "@wecode:registry=https://npm.example.com\n",
  );
});

test("resolveUserNpmrcPath prefers NPM_CONFIG_USERCONFIG and otherwise uses platform-specific home", async () => {
  await withTempDir(async (homeDir) => {
    assert.equal(
      resolveUserNpmrcPath(
        {
          HOME: homeDir,
          USERPROFILE: path.join(homeDir, "profile"),
          NPM_CONFIG_USERCONFIG: path.join(homeDir, "custom", ".npmrc"),
        },
        "linux",
      ),
      path.join(homeDir, "custom", ".npmrc"),
    );

    assert.equal(
      resolveUserNpmrcPath(
        {
          HOME: homeDir,
          USERPROFILE: path.join(homeDir, "profile"),
        },
        "linux",
      ),
      path.join(homeDir, ".npmrc"),
    );

    assert.equal(
      resolveUserNpmrcPath(
        {
          USERPROFILE: path.join(homeDir, "profile"),
        },
        "win32",
      ),
      path.join(homeDir, "profile", ".npmrc"),
    );
  });
});
