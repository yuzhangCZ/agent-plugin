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
const OUTFILE = path.join(DIST_DIR, "index.js");

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
    entryPoints: [path.join(PACKAGE_DIR, "src", "index.ts")],
    outfile: OUTFILE,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: mode === "dev",
    minify: mode === "prod",
  });

  await access(OUTFILE, constants.R_OK);

  console.log("Built qrcode auth package:");
  console.log(`- ${OUTFILE}`);
  console.log(`- mode: ${mode}`);
}

main().catch((error) => {
  console.error("[build-package] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
