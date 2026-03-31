#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@wecode/skill-openclaw-plugin";
const PLUGIN_ID = "skill-openclaw-plugin";
const PLUGIN_LABEL = "skill-openclaw-plugin";
const CHANNEL_ID = "message-bridge";
const NPM_SCOPE = "@wecode:registry=";

function createInstallerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeCliPath(candidatePath) {
  const slashNormalized = candidatePath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(slashNormalized)) {
    return slashNormalized.toLowerCase();
  }

  if (/^\/[A-Za-z]:\//.test(slashNormalized)) {
    return slashNormalized.slice(1).toLowerCase();
  }

  return path.resolve(candidatePath).replace(/\\/g, "/");
}

export function isCliEntry(importMetaUrl, argvEntry, cwd = process.cwd()) {
  if (!argvEntry) {
    return false;
  }

  const importMetaPath = normalizeCliPath(fileURLToPath(importMetaUrl));
  const argvPath = normalizeCliPath(path.resolve(cwd, argvEntry));
  return importMetaPath === argvPath;
}

export function resolvePackageRoot(importMetaUrl = import.meta.url) {
  const scriptPath = fileURLToPath(importMetaUrl);
  const scriptDir = path.dirname(scriptPath);

  for (const candidate of [scriptDir, path.resolve(scriptDir, "..")]) {
    if (existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  throw createInstallerError("INSTALLER_PACKAGE_ROOT_NOT_FOUND", `Unable to locate package.json for ${scriptPath}`);
}

export function resolveWindowsHomeDir(env = process.env) {
  if (env.USERPROFILE) {
    return env.USERPROFILE;
  }
  if (env.HOMEDRIVE && env.HOMEPATH) {
    return `${env.HOMEDRIVE}${env.HOMEPATH}`;
  }
  return homedir();
}

export function resolveUserNpmrcPath(env = process.env, platform = process.platform) {
  if (env.NPM_CONFIG_USERCONFIG) {
    return env.NPM_CONFIG_USERCONFIG;
  }

  if (platform === "win32") {
    return path.join(resolveWindowsHomeDir(env), ".npmrc");
  }

  return path.join(env.HOME || homedir(), ".npmrc");
}

export async function readOptionalTextFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function readScopedRegistry(content) {
  if (!content) {
    return "";
  }

  const match = content.match(/^\s*@wecode:registry=(.+?)\s*$/m);
  return match?.[1]?.trim() ?? "";
}

export function resolveRegistryValue({
  cliRegistry = "",
  envRegistry = "",
  npmrcContent = null,
}) {
  const normalizedCliRegistry = String(cliRegistry ?? "").trim();
  if (normalizedCliRegistry) {
    return normalizedCliRegistry;
  }

  const normalizedEnvRegistry = String(envRegistry ?? "").trim();
  if (normalizedEnvRegistry) {
    return normalizedEnvRegistry;
  }

  const existingRegistry = readScopedRegistry(npmrcContent);
  if (existingRegistry) {
    return existingRegistry;
  }

  throw createInstallerError(
    "REGISTRY_NOT_CONFIGURED",
    "Missing @wecode registry. Pass --registry, set WECODE_NPM_REGISTRY, or preconfigure ~/.npmrc.",
  );
}

export function buildNextNpmrcContent(existingContent, registry) {
  const normalizedRegistry = String(registry ?? "").trim();
  if (!normalizedRegistry) {
    throw createInstallerError("REGISTRY_NOT_CONFIGURED", "Registry value cannot be empty.");
  }

  const existingRegistry = readScopedRegistry(existingContent);
  if (existingRegistry === normalizedRegistry) {
    return existingContent;
  }

  if (existingRegistry) {
    return existingContent.replace(/^\s*@wecode:registry=.*$/m, `${NPM_SCOPE}${normalizedRegistry}`);
  }

  const prefix =
    existingContent && existingContent.trim().length > 0 ? `${existingContent.replace(/\s*$/, "")}\n` : "";
  return `${prefix}${NPM_SCOPE}${normalizedRegistry}\n`;
}

async function writeFileAtomically(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-install-"));
  const tempPath = path.join(tempDir, "config.tmp");
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function parseVersion(text) {
  const match = String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
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
    throw createInstallerError(
      "OPENCLAW_VERSION_UNSUPPORTED",
      `Unsupported OpenClaw version range: ${normalizedRange || "<empty>"}`,
    );
  }

  const minVersion = parseVersion(normalizedRange.slice(2));
  const currentVersion = parseVersion(actualVersion);
  if (!minVersion || !currentVersion) {
    throw createInstallerError(
      "OPENCLAW_VERSION_UNSUPPORTED",
      `Unable to compare OpenClaw version ${actualVersion} against ${normalizedRange}.`,
    );
  }

  if (compareVersion(currentVersion, minVersion) < 0) {
    throw createInstallerError(
      "OPENCLAW_VERSION_UNSUPPORTED",
      `Current OpenClaw version ${actualVersion} does not satisfy required range ${normalizedRange}.`,
    );
  }
}

export function resolveOpenClawCommand({ cliOpenclawBin = "", env = process.env } = {}) {
  const explicitCommand = String(cliOpenclawBin ?? "").trim() || String(env.OPENCLAW_BIN ?? "").trim();
  if (explicitCommand) {
    return explicitCommand;
  }

  return "openclaw";
}

export async function preflightOpenClaw({ openclawBin, requiredRange }) {
  const result = spawnSync(openclawBin, ["--version"], {
    encoding: "utf8",
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw createInstallerError(
        "OPENCLAW_NOT_FOUND",
        `OpenClaw command not found: ${openclawBin}. Please install OpenClaw first.`,
      );
    }
    throw createInstallerError(
      "OPENCLAW_NOT_FOUND",
      `Failed to execute OpenClaw command ${openclawBin}: ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw createInstallerError(
      "OPENCLAW_NOT_FOUND",
      `Failed to execute ${openclawBin} --version${detail ? `: ${detail}` : ""}`,
    );
  }

  const version = (result.stdout || result.stderr || "").trim();
  assertVersionSatisfies(version, requiredRange);
  return { openclawBin, version };
}

export function parseArgs(argv) {
  const parsed = {
    dev: false,
    noRestart: false,
    registry: "",
    url: "",
    token: "",
    password: "",
    name: "",
    openclawBin: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--dev":
        parsed.dev = true;
        break;
      case "--no-restart":
        parsed.noRestart = true;
        break;
      case "--registry":
        parsed.registry = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--url":
        parsed.url = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--token":
        parsed.token = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--password":
        parsed.password = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--name":
        parsed.name = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--openclaw-bin":
        parsed.openclawBin = argv[index + 1] ?? "";
        index += 1;
        break;
      default:
        throw createInstallerError("INSTALLER_USAGE_ERROR", `Unsupported argument: ${arg}`);
    }
  }

  return parsed;
}

function formatStep(message) {
  return `[${PLUGIN_LABEL}] ${message}`;
}

function writeStdout(message) {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}

function spawnForwarded(cmd, args, failureCode, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
      shell: false,
    });

    let combined = "";
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      combined += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      combined += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(createInstallerError("OPENCLAW_NOT_FOUND", `OpenClaw command not found: ${cmd}`));
        return;
      }
      reject(createInstallerError(failureCode, error.message));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ combined });
        return;
      }
      reject(
        createInstallerError(
          failureCode,
          `${cmd} ${args.join(" ")} failed with code ${code}`,
        ),
      );
    });
  });
}

function execJson(cmd, args, failureCode, cwd = process.cwd()) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw createInstallerError("OPENCLAW_NOT_FOUND", `OpenClaw command not found: ${cmd}`);
    }
    throw createInstallerError(failureCode, result.error.message);
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw createInstallerError(
      failureCode,
      `${cmd} ${args.join(" ")} failed with code ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw createInstallerError(
      failureCode,
      `Failed to parse JSON from ${cmd} ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function runInstaller({
  argv = process.argv.slice(2),
  env = process.env,
  importMetaUrl = import.meta.url,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);
  const packageRoot = resolvePackageRoot(importMetaUrl);
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const requiredRange = packageJson.peerDependencies?.openclaw ?? ">=0.0.0";
  const openclawBin = resolveOpenClawCommand({
    cliOpenclawBin: args.openclawBin,
    env,
  });
  const npmrcPath = resolveUserNpmrcPath(env);
  const existingNpmrc = await readOptionalTextFile(npmrcPath);
  const registry = resolveRegistryValue({
    cliRegistry: args.registry,
    envRegistry: env.WECODE_NPM_REGISTRY,
    npmrcContent: existingNpmrc,
  });

  writeStdout(formatStep("正在检查 OpenClaw 环境"));
  const openclaw = await preflightOpenClaw({ openclawBin, requiredRange });
  writeStdout(formatStep(`已检测到 OpenClaw: ${openclaw.openclawBin} (${openclaw.version})`));

  writeStdout(formatStep("正在配置 @wecode 二方仓源"));
  const nextNpmrc = buildNextNpmrcContent(existingNpmrc, registry);
  if (nextNpmrc !== existingNpmrc) {
    await writeFileAtomically(npmrcPath, nextNpmrc);
  }
  writeStdout(formatStep(`npm scope 配置文件: ${npmrcPath}`));
  writeStdout(formatStep(`使用 registry: ${registry}`));

  const openclawArgsPrefix = args.dev ? ["--dev"] : [];

  writeStdout(formatStep(`正在通过 OpenClaw 安装 ${PLUGIN_LABEL} 插件`));
  await spawnForwarded(
    openclaw.openclawBin,
    [...openclawArgsPrefix, "plugins", "install", PACKAGE_NAME],
    "PLUGIN_INSTALL_FAILED",
    cwd,
  );

  writeStdout(formatStep(`${PLUGIN_LABEL} 插件安装命令执行完成，正在校验安装结果`));
  const pluginInfo = execJson(
    openclaw.openclawBin,
    [...openclawArgsPrefix, "plugins", "info", PLUGIN_ID, "--json"],
    "PLUGIN_INSTALL_VERIFICATION_FAILED",
    cwd,
  );
  if (pluginInfo.id !== PLUGIN_ID || !Array.isArray(pluginInfo.channelIds) || !pluginInfo.channelIds.includes(CHANNEL_ID)) {
    throw createInstallerError(
      "PLUGIN_INSTALL_VERIFICATION_FAILED",
      `Plugin install verification failed for ${PLUGIN_ID}.`,
    );
  }
  writeStdout(formatStep(`${PLUGIN_LABEL} 插件安装校验通过`));

  writeStdout(formatStep("正在配置 Message Bridge channel"));
  const hasNonInteractiveArgs = Boolean(args.url && args.token && args.password);
  const channelArgs = hasNonInteractiveArgs
    ? [
        ...openclawArgsPrefix,
        "channels",
        "add",
        "--channel",
        CHANNEL_ID,
        "--url",
        args.url,
        "--token",
        args.token,
        "--password",
        args.password,
        ...(args.name ? ["--name", args.name] : []),
      ]
    : [...openclawArgsPrefix, "channels", "add", "--channel", CHANNEL_ID];
  await spawnForwarded(openclaw.openclawBin, channelArgs, "CHANNEL_ADD_FAILED", cwd);

  if (!args.noRestart) {
    writeStdout(formatStep("正在重启 OpenClaw gateway"));
    await spawnForwarded(
      openclaw.openclawBin,
      [...openclawArgsPrefix, "gateway", "restart"],
      "GATEWAY_RESTART_FAILED",
      cwd,
    );
  }

  writeStdout(formatStep("安装完成，可执行 channels status 进行确认"));
  writeStdout(
    formatStep(
      `建议执行: ${openclaw.openclawBin} ${[...openclawArgsPrefix, "channels", "status", "--channel", CHANNEL_ID, "--probe", "--json"].join(" ")}`,
    ),
  );
}

async function main() {
  try {
    await runInstaller();
  } catch (error) {
    const errorCode = error && typeof error === "object" && "code" in error ? error.code : "INSTALLER_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`error_code=${errorCode}`);
    writeStderr(message);
    process.exit(1);
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  main();
}
