import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NpmrcRegistryConfigAdapter } from "../../src/adapters/NpmrcRegistryConfigAdapter.ts";

test("NpmrcRegistryConfigAdapter resolves and upserts scoped registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-npmrc-"));
  try {
    const npmrcPath = join(dir, ".npmrc");
    await writeFile(npmrcPath, "registry=https://registry.npmjs.org/\n", "utf8");
    const adapter = new NpmrcRegistryConfigAdapter(npmrcPath);

    assert.equal(
      await adapter.resolveRegistry(),
      "https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/",
    );

    const applied = await adapter.ensureRegistry("https://npm.example.com");
    assert.equal(applied.changed, true);
    assert.equal(
      await readFile(npmrcPath, "utf8"),
      "registry=https://registry.npmjs.org/\n@wecode:registry=https://npm.example.com/\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
