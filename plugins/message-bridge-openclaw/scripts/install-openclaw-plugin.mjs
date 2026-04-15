#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildOpenClawInvocation, resolveOpenClawCommandSpec } from "./openclaw-command-resolver.mjs";

const PACKAGE_NAME = "@wecode/skill-openclaw-plugin";
const PLUGIN_ID = "skill-openclaw-plugin";
const PLUGIN_LABEL = "skill-openclaw-plugin";
const CHANNEL_ID = "message-bridge";
const NPM_SCOPE = "@wecode:registry=";
const DEFAULT_SCOPE_REGISTRY = "https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/";
const INSTALL_SUPPORTED_HOST_RANGE = ">=2026.3.24 <2026.3.31";

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

function resolveWindowsHomeDir(env = process.env) {
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

function readScopedRegistry(content) {
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

  return DEFAULT_SCOPE_REGISTRY;
}

export function buildNextNpmrcContent(existingContent, registry = DEFAULT_SCOPE_REGISTRY) {
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

function parseVersionComparators(range) {
  const normalizedRange = String(range ?? "").trim();
  if (!normalizedRange) {
    throw createInstallerError("OPENCLAW_VERSION_UNSUPPORTED", "Unsupported OpenClaw version range: <empty>");
  }

  const comparators = normalizedRange
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/);
      if (!match) {
        throw createInstallerError(
          "OPENCLAW_VERSION_UNSUPPORTED",
          `Unsupported OpenClaw version range: ${normalizedRange}`,
        );
      }

      const operator = match[1] ?? "=";
      const version = parseVersion(match[2]);
      if (!version) {
        throw createInstallerError(
          "OPENCLAW_VERSION_UNSUPPORTED",
          `Unable to compare OpenClaw version range: ${normalizedRange}`,
        );
      }

      return { operator, version };
    });

  if (comparators.length === 0) {
    throw createInstallerError("OPENCLAW_VERSION_UNSUPPORTED", "Unsupported OpenClaw version range: <empty>");
  }

  return comparators;
}

export function assertVersionSatisfies(actualVersion, range) {
  const currentVersion = parseVersion(actualVersion);
  if (!currentVersion) {
    throw createInstallerError(
      "OPENCLAW_VERSION_UNSUPPORTED",
      `Unable to compare OpenClaw version ${actualVersion} against ${String(range ?? "").trim() || "<empty>"}.`,
    );
  }

  const comparators = parseVersionComparators(range);
  const satisfied = comparators.every(({ operator, version }) => {
    const result = compareVersion(currentVersion, version);
    switch (operator) {
      case ">=":
        return result >= 0;
      case "<=":
        return result <= 0;
      case ">":
        return result > 0;
      case "<":
        return result < 0;
      case "=":
        return result === 0;
      default:
        return false;
    }
  });

  if (!satisfied) {
    throw createInstallerError(
      "OPENCLAW_VERSION_UNSUPPORTED",
      `Current OpenClaw version ${actualVersion} does not satisfy required range ${range}.`,
    );
  }
}

function runCommandSync(command, args, {
  cwd,
  env = process.env,
  encoding = "utf8",
} = {}) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding,
    shell: false,
  });
}

export async function preflightOpenClaw({
  openclawBin = "",
  requiredRange,
  env = process.env,
  platform = process.platform,
  runSync = runCommandSync,
} = {}) {
  const resolved = resolveOpenClawCommandSpec({
    cliOpenclawBin: openclawBin,
    env,
    platform,
    runSync,
  });
  const command = resolved.resolvedCommand;
  const result = resolved.versionResult;

  if (resolved.usedPathLookup && platform === "win32" && command !== "openclaw") {
    writeStdout(formatStep(`Windows 环境通过 where.exe 检测到 openclaw shim，后续将使用 ${command}`));
  }

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw createInstallerError(
        "OPENCLAW_NOT_FOUND",
        `OpenClaw command not found: ${command}. Please install OpenClaw first.`,
      );
    }
    throw createInstallerError(
      "OPENCLAW_NOT_FOUND",
      `Failed to execute OpenClaw command ${command}: ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw createInstallerError(
      "OPENCLAW_NOT_FOUND",
      `Failed to execute ${command} --version${detail ? `: ${detail}` : ""}`,
    );
  }

  const version = (result.stdout || result.stderr || "").trim();
  assertVersionSatisfies(version, requiredRange);
  return {
    openclawBin: command,
    executionMode: resolved.executionMode,
    version,
  };
}

function formatDisplayCommand(openclaw, args) {
  return `${openclaw.openclawBin} ${args.join(" ")}`.trim();
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

function spawnForwarded(openclaw, args, failureCode, cwd = process.cwd()) {
  const invocation = buildOpenClawInvocation({
    resolvedCommand: openclaw.openclawBin,
    executionMode: openclaw.executionMode,
    args,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(createInstallerError("OPENCLAW_NOT_FOUND", `OpenClaw command not found: ${openclaw.openclawBin}`));
        return;
      }
      reject(createInstallerError(failureCode, error.message));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({});
        return;
      }
      reject(
        createInstallerError(
          failureCode,
          `${formatDisplayCommand(openclaw, args)} failed with code ${code}`,
        ),
      );
    });
  });
}

function execJson(openclaw, args, failureCode, cwd = process.cwd()) {
  const invocation = buildOpenClawInvocation({
    resolvedCommand: openclaw.openclawBin,
    executionMode: openclaw.executionMode,
    args,
  });
  const result = runCommandSync(invocation.command, invocation.args, {
    cwd,
    env: process.env,
    encoding: "utf8",
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw createInstallerError("OPENCLAW_NOT_FOUND", `OpenClaw command not found: ${openclaw.openclawBin}`);
    }
    throw createInstallerError(failureCode, result.error.message);
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw createInstallerError(
      failureCode,
      `${formatDisplayCommand(openclaw, args)} failed with code ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw createInstallerError(
      failureCode,
      `Failed to parse JSON from ${formatDisplayCommand(openclaw, args)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
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
  resolvePackageRoot(importMetaUrl);
  const requiredRange = INSTALL_SUPPORTED_HOST_RANGE;
  const npmrcPath = resolveUserNpmrcPath(env);
  const existingNpmrc = await readOptionalTextFile(npmrcPath);
  const registry = resolveRegistryValue({
    cliRegistry: args.registry,
    envRegistry: env.WECODE_NPM_REGISTRY,
    npmrcContent: existingNpmrc,
  });

  writeStdout(formatStep("正在检查 OpenClaw 环境"));
  const openclaw = await preflightOpenClaw({
    openclawBin: args.openclawBin,
    requiredRange,
    env,
  });
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
    openclaw,
    [...openclawArgsPrefix, "plugins", "install", PACKAGE_NAME],
    "PLUGIN_INSTALL_FAILED",
    cwd,
  );

  writeStdout(formatStep(`${PLUGIN_LABEL} 插件安装命令执行完成，正在校验安装结果`));
  const pluginInfo = execJson(
    openclaw,
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
  await spawnForwarded(openclaw, channelArgs, "CHANNEL_ADD_FAILED", cwd);

  if (!args.noRestart) {
    writeStdout(formatStep("正在重启 OpenClaw gateway"));
    await spawnForwarded(
      openclaw,
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
