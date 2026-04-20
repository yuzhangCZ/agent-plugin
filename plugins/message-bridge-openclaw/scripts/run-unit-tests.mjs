import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ensureOpenClawTestStub } from "./ensure-openclaw-test-stub.mjs";

const stub = await ensureOpenClawTestStub();
const packageDir = new URL("..", import.meta.url);
const unitTestsDir = new URL("../tests/unit", import.meta.url);
const unitTestFiles = (await readdir(unitTestsDir))
  .filter((entry) => entry.endsWith(".test.mjs"))
  .sort()
  .map((entry) => path.join("tests", "unit", entry));

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--test", ...unitTestFiles],
      {
        cwd: packageDir,
        stdio: "inherit",
      },
    );
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", reject);
  });

  process.exitCode = exitCode;
} finally {
  await stub.cleanup();
}
