import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeFileAtomically } from "../../src/infrastructure/fs-utils.ts";

test("writeFileAtomically writes via target directory instead of process temp directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-fs-utils-"));
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = join(dir, "missing-tmp");
  try {
    const targetPath = join(dir, "opencode", "opencode.json");

    await writeFileAtomically(targetPath, '{ "plugin": [] }\n');

    assert.equal(await readFile(targetPath, "utf8"), '{ "plugin": [] }\n');
  } finally {
    if (previousTmpDir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpDir;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
