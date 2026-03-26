import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, "..");
export const BUNDLE_DIR = path.join(ROOT_DIR, "bundle");

export function createFailure(failureCategory, message, failureCode = failureCategory) {
  const error = new Error(message);
  error.failureCategory = failureCategory;
  error.failureCode = failureCode;
  return error;
}

export function ensureCommand(cmd) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [cmd], { encoding: "utf8" });
  if (result.status !== 0) {
    throw createFailure("ENV_MISSING_CMD", `Missing required command: ${cmd}`, "ENV_MISSING_CMD");
  }
}

export function readCommandVersion(cmd, args = ["--version"]) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw createFailure("ENV_VERSION_READ_FAILED", `Failed to determine command version for ${cmd}`);
  }
  return result.stdout.trim() || result.stderr.trim() || "unknown";
}

export function createIsolatedHomeEnv(homeDir, extraEnv = {}) {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    ...extraEnv,
  };
}

function normalizeCliEntryPath(candidatePath) {
  const slashNormalized = candidatePath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(slashNormalized)) {
    return slashNormalized.toLowerCase();
  }

  if (/^\/[A-Za-z]:\//.test(slashNormalized)) {
    return slashNormalized.slice(1).toLowerCase();
  }

  return path.resolve(candidatePath).replace(/\\/g, "/");
}

function normalizeWindowsCwd(cwd) {
  if (/^[A-Za-z]:[\\/]/.test(cwd)) {
    return cwd;
  }

  return cwd.replace(/\//g, "\\");
}

function isWindowsNormalizedPath(candidatePath) {
  return /^[a-z]:\//.test(candidatePath);
}

function normalizeCliArgvEntry(argvEntry, windowsPath, cwd = process.cwd()) {
  const resolvedEntry = windowsPath ? path.win32.resolve(normalizeWindowsCwd(cwd), argvEntry) : path.resolve(argvEntry);
  return normalizeCliEntryPath(resolvedEntry);
}

export function isCliEntry(importMetaUrl, argvEntry, cwd = process.cwd()) {
  if (!argvEntry) {
    return false;
  }

  const importMetaPath = normalizeCliEntryPath(fileURLToPath(importMetaUrl));
  const argvPath = normalizeCliArgvEntry(argvEntry, isWindowsNormalizedPath(importMetaPath), cwd);
  return importMetaPath === argvPath;
}

function resolveExplicitOpenClawCommand() {
  const candidate = process.env.OPENCLAW_BIN?.trim();
  if (!candidate) {
    return null;
  }

  if (!existsSync(candidate)) {
    throw createFailure(
      "ENV_MISSING_CMD",
      `OPENCLAW_BIN points to a missing path: ${candidate}`,
      "ENV_MISSING_CMD",
    );
  }

  return candidate;
}

export function resolveOpenClawCommand() {
  const explicitCommand = resolveExplicitOpenClawCommand();
  if (explicitCommand) {
    return explicitCommand;
  }

  ensureCommand("openclaw");
  return "openclaw";
}

function parseVersion(text) {
  const match = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

export function assertVersionSatisfies(actualVersion, range) {
  const normalizedRange = String(range ?? "").trim();
  if (!normalizedRange.startsWith(">=")) {
    throw createFailure("ENV_VERSION_UNSUPPORTED_RANGE", `Unsupported version range: ${normalizedRange}`);
  }

  const minVersion = parseVersion(normalizedRange.slice(2));
  const currentVersion = parseVersion(actualVersion);
  if (!minVersion || !currentVersion) {
    throw createFailure("ENV_VERSION_PARSE_FAILED", `Unable to compare versions: ${actualVersion} vs ${normalizedRange}`);
  }

  if (compareVersion(currentVersion, minVersion) < 0) {
    throw createFailure(
      "ENV_VERSION_MISMATCH",
      `OpenClaw ${actualVersion} does not satisfy required range ${normalizedRange}`,
      "ENV_VERSION_MISMATCH",
    );
  }
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT_DIR,
      stdio: opts.stdio ?? "inherit",
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

export function spawnLoggedProcess(cmd, args, logfile, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? ROOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: false,
  });
  child.stdout?.on("data", (chunk) => opts.onStdout?.(chunk.toString()));
  child.stderr?.on("data", (chunk) => opts.onStderr?.(chunk.toString()));
  child.stdout?.on("data", (chunk) => opts.append?.(logfile, chunk.toString()));
  child.stderr?.on("data", (chunk) => opts.append?.(logfile, chunk.toString()));
  return child;
}

export async function createTempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export function findAvailablePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => {
      if (port === 0) {
        reject(createFailure("ENV_PORT_UNAVAILABLE", "Unable to find an available port"));
        return;
      }
      resolve(findAvailablePort(0));
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const resolvedPort = typeof address === "object" && address ? address.port : port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(resolvedPort);
      });
    });
  });
}

export async function waitForPattern(file, pattern, maxTries, intervalMs = 200, reader) {
  for (let tries = 0; tries < maxTries; tries += 1) {
    try {
      const text = await reader(file);
      if (pattern.test(text)) {
        return true;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export async function withTimeout(task, ms, label, category, timeoutCode) {
  let timer = null;
  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(createFailure(category, `${label} timed out after ${ms}ms`, timeoutCode));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
