#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");
const DIST_DIR = path.join(PACKAGE_DIR, "dist");
const README_PATH = path.join(PACKAGE_DIR, "README.md");
const PACKAGE_JSON_PATH = path.join(PACKAGE_DIR, "package.json");
const TEMP_ROOT_DIR = path.join(PACKAGE_DIR, ".tmp");
const DEFAULT_PACK_DESTINATION = path.join(PACKAGE_DIR, ".tmp", "release-pack");
const RELEASE_FILES = Object.freeze(["dist", "README.md"]);
const RELEASE_MANIFEST_KEYS = Object.freeze([
  "name",
  "version",
  "type",
  "bin",
  "description",
  "keywords",
  "author",
  "license",
  "homepage",
  "repository",
  "bugs",
  "funding",
  "publishConfig",
  "engines",
  "os",
  "cpu",
]);

function readOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function parseArgs(argv) {
  let packDestination = DEFAULT_PACK_DESTINATION;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--pack-destination") {
      packDestination = path.resolve(PACKAGE_DIR, readOptionValue(argv, index, "--pack-destination"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--pack-destination=")) {
      packDestination = path.resolve(PACKAGE_DIR, arg.slice("--pack-destination=".length));
      continue;
    }

    throw new Error(`unknown flag: ${arg}`);
  }

  return {
    packDestination,
  };
}

function createReleaseManifest(manifest) {
  const releaseManifest = {};
  for (const key of RELEASE_MANIFEST_KEYS) {
    if (Object.hasOwn(manifest, key) && manifest[key] !== undefined) {
      releaseManifest[key] = manifest[key];
    }
  }

  releaseManifest.files = ["dist/", "README.md", "package.json"];
  return releaseManifest;
}

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
  const { packDestination } = parseArgs(process.argv.slice(2));
  await access(path.join(DIST_DIR, "cli.js"), constants.R_OK);
  await access(README_PATH, constants.R_OK);
  await access(PACKAGE_JSON_PATH, constants.R_OK);

  const sourceManifest = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8"));
  const releaseManifest = createReleaseManifest(sourceManifest);
  await mkdir(TEMP_ROOT_DIR, { recursive: true });
  await rm(packDestination, { recursive: true, force: true });
  await mkdir(packDestination, { recursive: true });

  const stagingRoot = await mkdtemp(path.join(TEMP_ROOT_DIR, "release-stage-"));
  try {
    for (const entry of RELEASE_FILES) {
      await cp(path.join(PACKAGE_DIR, entry), path.join(stagingRoot, entry), { recursive: true });
    }
    await writeFile(path.join(stagingRoot, "package.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");
    await run("npm", ["pack", "--pack-destination", packDestination], {
      cwd: stagingRoot,
      env: { npm_config_cache: path.join(TEMP_ROOT_DIR, "npm-cache") },
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[build-release-tarball] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
