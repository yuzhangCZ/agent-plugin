import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { create as createTarball } from "tar";
import { TarballExtractor } from "../../src/adapters/TarballExtractor.ts";
import { InstallCliError } from "../../src/domain/errors.ts";

async function createPackageFixture(root: string) {
  const packageDir = join(root, "package");
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@wecode/skill-plugin", version: "1.2.3", main: "dist/index.js" }, null, 2),
    "utf8",
  );
  await writeFile(join(packageDir, "dist/index.js"), "export default 1;\n", "utf8");
}

test("TarballExtractor extracts valid tgz into target directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-tarball-"));
  try {
    await createPackageFixture(dir);
    const tgzPath = join(dir, "plugin.tgz");
    const targetDir = join(dir, "output");
    await mkdir(targetDir, { recursive: true });
    await createTarball({ cwd: dir, file: tgzPath, gzip: true }, ["package"]);

    await new TarballExtractor().extract(tgzPath, targetDir);

    assert.equal(await readFile(join(targetDir, "package", "dist/index.js"), "utf8"), "export default 1;\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TarballExtractor throws PLUGIN_ARTIFACT_FETCH_FAILED for corrupted tgz", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-tarball-"));
  try {
    const tgzPath = join(dir, "broken.tgz");
    const targetDir = join(dir, "output");
    await mkdir(targetDir, { recursive: true });
    await writeFile(tgzPath, "broken-content", "utf8");

    await assert.rejects(
      async () => {
        await new TarballExtractor().extract(tgzPath, targetDir);
      },
      (error) => error instanceof InstallCliError && error.code === "PLUGIN_ARTIFACT_FETCH_FAILED",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
