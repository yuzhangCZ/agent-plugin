import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { create as createTarball } from "tar";
import { NpmPluginArtifactAdapter } from "../../src/adapters/NpmPluginArtifactAdapter.ts";
import { InstallCliError } from "../../src/domain/errors.ts";
import type { ProcessRunner } from "../../src/domain/ports.ts";

type PackageScenario = {
  main?: string;
  exports?: string;
  entryContent?: string;
  openclawManifestContent?: string;
  omitEntrypoint?: boolean;
  omitOpenClawManifest?: boolean;
};

class ScenarioProcessRunner implements ProcessRunner {
  private readonly scenarioRoot: string;
  private readonly packMode?: "corrupt";
  private packCount = 0;

  constructor(scenarioRoot: string, options: { packMode?: "corrupt" } = {}) {
    this.scenarioRoot = scenarioRoot;
    this.packMode = options.packMode;
  }

  async exec(command: string, args: string[]) {
    if (command === "npm" && args[0] === "view") {
      return { stdout: "1.2.3\n", stderr: "", exitCode: 0 };
    }
    if (command === "npm" && args[0] === "pack") {
      const destination = args[args.indexOf("--pack-destination") + 1];
      const tarballName = "wecode-skill-plugin-1.2.3.tgz";
      const tarballPath = join(destination, tarballName);
      const scenarioDir = join(this.scenarioRoot, `pack-${this.packCount}`);
      this.packCount += 1;
      if (this.packMode === "corrupt") {
        await writeFile(tarballPath, "not-a-valid-tgz", "utf8");
        return { stdout: `${tarballName}\n`, stderr: "", exitCode: 0 };
      }
      await createTarball({ cwd: scenarioDir, file: tarballPath, gzip: true }, ["package"]);
      return { stdout: `${tarballName}\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  }

  async spawn() {
    return { exitCode: 0 };
  }

  async spawnDetached() {
    return;
  }
}

async function writePackageFixture(root: string, index: number, scenario: PackageScenario) {
  const scenarioRoot = join(root, `pack-${index}`, "package");
  await mkdir(join(scenarioRoot, "dist"), { recursive: true });
  const main = scenario.main ?? "dist/index.js";
  const manifest: Record<string, unknown> = { main };
  if (scenario.exports) {
    manifest.exports = scenario.exports;
  }
  await writeFile(join(scenarioRoot, "package.json"), JSON.stringify(manifest, null, 2), "utf8");
  if (!scenario.omitEntrypoint) {
    await writeFile(join(scenarioRoot, main), scenario.entryContent ?? "export default 1;\n", "utf8");
  }
  if (!scenario.omitOpenClawManifest) {
    await writeFile(
      join(scenarioRoot, "openclaw.plugin.json"),
      scenario.openclawManifestContent ?? JSON.stringify({ id: "skill-openclaw-plugin" }, null, 2),
      "utf8",
    );
  }
}

function createAdapter(homeDir: string, scenarioRoot: string, options: { packMode?: "corrupt" } = {}) {
  return new NpmPluginArtifactAdapter(new ScenarioProcessRunner(scenarioRoot, options), { HOME: homeDir });
}

function resolveFormalExtractRoot(homeDir: string, host: "opencode" | "openclaw", packageName: string) {
  return resolve(homeDir, ".cache", "skill-plugin-cli", host, "extracted", packageName, "1.2.3");
}

function createFileOpsWithRenameFailure(targetPath: string, options: { failRollback?: boolean } = {}) {
  let renameAttempts = 0;
  return {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    async rename(oldPath: string, newPath: string) {
      renameAttempts += 1;
      if (newPath === targetPath && renameAttempts === 2) {
        throw new Error("simulated rename failure");
      }
      if (options.failRollback && renameAttempts === 3) {
        throw new Error("simulated rollback failure");
      }
      return rename(oldPath, newPath);
    },
  };
}

test("NpmPluginArtifactAdapter returns stable formal path for repeated opencode fallback fetches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-artifact-"));
  try {
    await writePackageFixture(dir, 0, {});
    await writePackageFixture(dir, 1, { entryContent: "export default 2;\n" });

    const adapter = createAdapter(dir, dir);
    const first = await adapter.fetchArtifact({
      host: "opencode",
      installStrategy: "fallback",
      packageName: "@wecode/skill-opencode-plugin",
      registry: "https://npm.example.com",
    });
    const second = await adapter.fetchArtifact({
      host: "opencode",
      installStrategy: "fallback",
      packageName: "@wecode/skill-opencode-plugin",
      registry: "https://npm.example.com",
    });

    const formalPackageDir = resolveFormalExtractRoot(dir, "opencode", "@wecode/skill-opencode-plugin");
    assert.equal(first.localExtractPath, join(formalPackageDir, "package"));
    assert.equal(first.pluginSpec, join(formalPackageDir, "package"));
    assert.equal(second.localExtractPath, join(formalPackageDir, "package"));
    assert.equal(second.pluginSpec, join(formalPackageDir, "package"));
    assert.doesNotMatch(first.localExtractPath || "", /\.tmp-/);
    assert.doesNotMatch(second.localExtractPath || "", /\.tmp-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NpmPluginArtifactAdapter rejects openclaw artifact without manifest contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-artifact-"));
  try {
    await writePackageFixture(dir, 0, { omitOpenClawManifest: true });

    const adapter = createAdapter(dir, dir);
    await assert.rejects(
      async () => {
        await adapter.fetchArtifact({
          host: "openclaw",
          installStrategy: "fallback",
          packageName: "@wecode/skill-openclaw-plugin",
          registry: "https://npm.example.com",
        });
      },
      (error) => error instanceof InstallCliError && error.code === "PLUGIN_ARTIFACT_INVALID",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NpmPluginArtifactAdapter does not reuse previous extracted files when same version package loses entrypoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-artifact-"));
  try {
    await writePackageFixture(dir, 0, {});
    await writePackageFixture(dir, 1, { omitEntrypoint: true });

    const adapter = createAdapter(dir, dir);
    await adapter.fetchArtifact({
      host: "opencode",
      installStrategy: "fallback",
      packageName: "@wecode/skill-opencode-plugin",
      registry: "https://npm.example.com",
    });

    await assert.rejects(
      async () => {
        await adapter.fetchArtifact({
          host: "opencode",
          installStrategy: "fallback",
          packageName: "@wecode/skill-opencode-plugin",
          registry: "https://npm.example.com",
        });
      },
      (error) => error instanceof InstallCliError
        && error.code === "PLUGIN_ARTIFACT_INVALID"
        && /dist\/index\.js/u.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NpmPluginArtifactAdapter keeps previous formal cache when same-version openclaw refresh fails contract validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-artifact-"));
  try {
    await writePackageFixture(dir, 0, {});
    await writePackageFixture(dir, 1, { omitOpenClawManifest: true });

    const adapter = createAdapter(dir, dir);
    await adapter.fetchArtifact({
      host: "openclaw",
      installStrategy: "fallback",
      packageName: "@wecode/skill-openclaw-plugin",
      registry: "https://npm.example.com",
    });

    const formalRoot = resolveFormalExtractRoot(dir, "openclaw", "@wecode/skill-openclaw-plugin");
    const manifestPath = join(formalRoot, "package", "package.json");
    const openclawManifestPath = join(formalRoot, "package", "openclaw.plugin.json");
    const manifestBefore = await readFile(manifestPath, "utf8");
    const openclawManifestBefore = await readFile(openclawManifestPath, "utf8");

    await assert.rejects(
      async () => {
        await adapter.fetchArtifact({
          host: "openclaw",
          installStrategy: "fallback",
          packageName: "@wecode/skill-openclaw-plugin",
          registry: "https://npm.example.com",
        });
      },
      (error) => error instanceof InstallCliError && error.code === "PLUGIN_ARTIFACT_INVALID",
    );

    assert.equal(await readFile(manifestPath, "utf8"), manifestBefore);
    assert.equal(await readFile(openclawManifestPath, "utf8"), openclawManifestBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NpmPluginArtifactAdapter cleans temporary directory after contract failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-artifact-"));
  try {
    await writePackageFixture(dir, 0, { omitEntrypoint: true });

    const adapter = createAdapter(dir, dir);
    await assert.rejects(
      async () => {
        await adapter.fetchArtifact({
          host: "opencode",
          installStrategy: "fallback",
          packageName: "@wecode/skill-opencode-plugin",
          registry: "https://npm.example.com",
        });
      },
      (error) => error instanceof InstallCliError && error.code === "PLUGIN_ARTIFACT_INVALID",
    );

    const extractedParentDir = join(dir, ".cache", "skill-plugin-cli", "opencode", "extracted", "@wecode", "skill-opencode-plugin");
    const entries = await readdir(extractedParentDir);
    assert.deepEqual(entries, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NpmPluginArtifactAdapter cleans temporary directory after tgz extraction failure and preserves formal cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-artifact-"));
  try {
    await writePackageFixture(dir, 0, {});

    const successAdapter = createAdapter(dir, dir);
    await successAdapter.fetchArtifact({
      host: "opencode",
      installStrategy: "fallback",
      packageName: "@wecode/skill-opencode-plugin",
      registry: "https://npm.example.com",
    });

    const formalRoot = resolveFormalExtractRoot(dir, "opencode", "@wecode/skill-opencode-plugin");
    const manifestPath = join(formalRoot, "package", "package.json");
    const manifestBefore = await readFile(manifestPath, "utf8");

    const failingAdapter = createAdapter(dir, dir, { packMode: "corrupt" });
    await assert.rejects(
      async () => {
        await failingAdapter.fetchArtifact({
          host: "opencode",
          installStrategy: "fallback",
          packageName: "@wecode/skill-opencode-plugin",
          registry: "https://npm.example.com",
        });
      },
      (error) => error instanceof InstallCliError && error.code === "PLUGIN_ARTIFACT_FETCH_FAILED",
    );

    assert.equal(await readFile(manifestPath, "utf8"), manifestBefore);
    const extractedParentDir = join(dir, ".cache", "skill-plugin-cli", "opencode", "extracted", "@wecode", "skill-opencode-plugin");
    const entries = await readdir(extractedParentDir);
    assert.deepEqual(entries, ["1.2.3"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NpmPluginArtifactAdapter restores previous formal cache when replacing formal directory fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-artifact-"));
  try {
    await writePackageFixture(dir, 0, { entryContent: "export default 1;\n" });
    await writePackageFixture(dir, 1, { entryContent: "export default 2;\n" });

    const successAdapter = createAdapter(dir, dir);
    await successAdapter.fetchArtifact({
      host: "opencode",
      installStrategy: "fallback",
      packageName: "@wecode/skill-opencode-plugin",
      registry: "https://npm.example.com",
    });

    const formalRoot = resolveFormalExtractRoot(dir, "opencode", "@wecode/skill-opencode-plugin");
    const entrypointPath = join(formalRoot, "package", "dist", "index.js");
    const entryBefore = await readFile(entrypointPath, "utf8");

    const adapter = new NpmPluginArtifactAdapter(
      new ScenarioProcessRunner(dir),
      { HOME: dir },
      createFileOpsWithRenameFailure(formalRoot),
    );

    await assert.rejects(
      async () => {
        await adapter.fetchArtifact({
          host: "opencode",
          installStrategy: "fallback",
          packageName: "@wecode/skill-opencode-plugin",
          registry: "https://npm.example.com",
        });
      },
      (error) => error instanceof InstallCliError && error.code === "PLUGIN_ARTIFACT_FETCH_FAILED",
    );

    assert.equal(await readFile(entrypointPath, "utf8"), entryBefore);
    const extractedParentDir = join(dir, ".cache", "skill-plugin-cli", "opencode", "extracted", "@wecode", "skill-opencode-plugin");
    const entries = await readdir(extractedParentDir);
    assert.deepEqual(entries, ["1.2.3"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NpmPluginArtifactAdapter preserves backup cache when replacing and rollback both fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-artifact-"));
  try {
    await writePackageFixture(dir, 0, { entryContent: "export default 1;\n" });
    await writePackageFixture(dir, 1, { entryContent: "export default 2;\n" });

    const successAdapter = createAdapter(dir, dir);
    await successAdapter.fetchArtifact({
      host: "opencode",
      installStrategy: "fallback",
      packageName: "@wecode/skill-opencode-plugin",
      registry: "https://npm.example.com",
    });

    const formalRoot = resolveFormalExtractRoot(dir, "opencode", "@wecode/skill-opencode-plugin");
    const backupRoot = `${formalRoot}.bak`;
    const adapter = new NpmPluginArtifactAdapter(
      new ScenarioProcessRunner(dir),
      { HOME: dir },
      createFileOpsWithRenameFailure(formalRoot, { failRollback: true }),
    );

    await assert.rejects(
      async () => {
        await adapter.fetchArtifact({
          host: "opencode",
          installStrategy: "fallback",
          packageName: "@wecode/skill-opencode-plugin",
          registry: "https://npm.example.com",
        });
      },
      (error) => error instanceof InstallCliError
        && error.code === "PLUGIN_ARTIFACT_FETCH_FAILED"
        && /旧缓存恢复失败/u.test(error.message),
    );

    await assert.rejects(async () => access(formalRoot));
    assert.equal(await readFile(join(backupRoot, "package", "dist", "index.js"), "utf8"), "export default 1;\n");
    const extractedParentDir = join(dir, ".cache", "skill-plugin-cli", "opencode", "extracted", "@wecode", "skill-opencode-plugin");
    const entries = (await readdir(extractedParentDir)).sort();
    assert.deepEqual(entries, ["1.2.3.bak"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
