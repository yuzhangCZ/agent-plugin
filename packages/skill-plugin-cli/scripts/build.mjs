#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? PACKAGE_DIR,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.stdio ?? "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

async function main() {
  await rm(path.join(PACKAGE_DIR, "dist"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await run(process.execPath, ["./scripts/build-package.mjs", "--mode=prod"], { cwd: PACKAGE_DIR });
  await run("tsc", ["--emitDeclarationOnly", "--project", "./tsconfig.json"], { cwd: PACKAGE_DIR });
  await run(process.execPath, ["./scripts/rewrite-dts-imports.mjs"], { cwd: PACKAGE_DIR });
}

main().catch((error) => {
  console.error("[build] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
