import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(".");
const distRoot = path.join(packageRoot, "dist");

function runScript(script: string): void {
  const result = spawnSync("pnpm", ["run", script], {
    cwd: packageRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function listDeclarationFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listDeclarationFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

test("build emits prod dist artifacts without sourcemap", { concurrency: false }, async () => {
  runScript("build");

  await access(path.join(distRoot, "index.js"));
  await access(path.join(distRoot, "index.d.ts"));
  await assert.rejects(access(path.join(distRoot, "index.js.map")));
});

test("build:dev emits sourcemap", { concurrency: false }, async () => {
  runScript("build:dev");

  await access(path.join(distRoot, "index.js"));
  await access(path.join(distRoot, "index.d.ts"));
  await access(path.join(distRoot, "index.js.map"));
});

test("prod bundle can be imported and exposes qrcodeAuth.run", { concurrency: false }, async () => {
  runScript("build");

  const modulePath = path.join(distRoot, "index.js");
  const imported = await import(pathToFileURL(modulePath).href);
  assert.equal(typeof imported.qrcodeAuth?.run, "function");

  const declarationFiles = await listDeclarationFiles(distRoot);
  assert.ok(declarationFiles.length > 0);

  const indexDts = await readFile(path.join(distRoot, "index.d.ts"), "utf8");
  assert.match(indexDts, /qrcodeAuth/);

  for (const filePath of declarationFiles) {
    const content = await readFile(filePath, "utf8");
    assert.doesNotMatch(content, /["'][^"']+\.ts["']/);
  }
});

test("pack:check validates release tarball contents", { concurrency: false }, () => {
  runScript("pack:check");
});
