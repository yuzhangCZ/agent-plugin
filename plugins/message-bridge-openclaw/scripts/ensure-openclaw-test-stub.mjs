import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const nodeModulesDir = path.join(packageDir, "node_modules");
const openclawDir = path.join(nodeModulesDir, "openclaw");
const stubRoot = path.join(packageDir, "tests", "stubs", "openclaw");
const markerFile = path.join(openclawDir, ".message-bridge-openclaw-test-stub");

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureOpenClawTestStub(baseDir = packageDir) {
  const targetNodeModulesDir = path.join(baseDir, "node_modules");
  const targetOpenClawDir = path.join(targetNodeModulesDir, "openclaw");
  const targetMarkerFile = path.join(targetOpenClawDir, ".message-bridge-openclaw-test-stub");

  if (await pathExists(targetMarkerFile)) {
    return {
      mode: "existing_stub",
      cleanup: async () => {
        await rm(targetOpenClawDir, { recursive: true, force: true });
      },
    };
  }

  if (await pathExists(targetOpenClawDir)) {
    return {
      mode: "existing_dependency",
      cleanup: async () => {},
    };
  }

  await mkdir(targetNodeModulesDir, { recursive: true });

  try {
    await symlink(stubRoot, targetOpenClawDir, "dir");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return {
        mode: "existing_dependency",
        cleanup: async () => {},
      };
    }
    throw error;
  }

  await writeFile(targetMarkerFile, "test-stub\n", "utf8");

  return {
    mode: "created_stub",
    cleanup: async () => {
      await rm(targetOpenClawDir, { recursive: true, force: true });
    },
  };
}

export async function cleanupOpenClawTestStub(baseDir = packageDir) {
  await rm(path.join(baseDir, "node_modules", "openclaw"), {
    recursive: true,
    force: true,
  });
}

async function main() {
  await ensureOpenClawTestStub();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
