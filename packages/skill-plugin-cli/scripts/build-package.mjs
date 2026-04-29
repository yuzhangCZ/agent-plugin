#!/usr/bin/env node
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");
const DIST_DIR = path.join(PACKAGE_DIR, "dist");

function resolveBuildMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg ? modeArg.slice("--mode=".length) : "prod";
  if (mode !== "prod" && mode !== "dev") {
    throw new Error(`invalid build mode: ${mode}. expected prod or dev`);
  }
  return mode;
}

async function main() {
  const mode = resolveBuildMode(process.argv.slice(2));
  await mkdir(DIST_DIR, { recursive: true });

  await build({
    bundle: true,
    entryPoints: {
      cli: path.join(PACKAGE_DIR, "src", "cli", "main.ts"),
    },
    outdir: DIST_DIR,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: mode === "dev",
    minify: mode === "prod",
  });

  await access(path.join(DIST_DIR, "cli.js"), constants.R_OK);
}

main().catch((error) => {
  console.error("[build-package] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
