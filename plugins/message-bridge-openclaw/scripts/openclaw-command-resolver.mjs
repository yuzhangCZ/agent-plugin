import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export const OPENCLAW_EXECUTION_MODE_DIRECT = "direct";
export const OPENCLAW_EXECUTION_MODE_WINDOWS_CMD = "windows-cmd";

function resolveRequestedCommand({ cliOpenclawBin = "", env = process.env } = {}) {
  const explicitCommand = String(cliOpenclawBin ?? "").trim() || String(env.OPENCLAW_BIN ?? "").trim();
  return {
    explicit: Boolean(explicitCommand),
    command: explicitCommand || "openclaw",
  };
}

function defaultRunSync(command, args, options = {}) {
  return spawnSync(command, args, {
    ...options,
    shell: false,
  });
}

function defaultRunShellSync(command, options = {}) {
  return spawnSync(command, {
    ...options,
    shell: true,
  });
}

function parseWhereCandidates(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function pickWindowsCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return "";
  }

  const firstCandidate = candidates[0];
  const firstDir = path.win32.dirname(firstCandidate);
  const preferred = candidates.find((candidate) => (
    path.win32.dirname(candidate) === firstDir
      && path.win32.basename(candidate).toLowerCase() === "openclaw.cmd"
  ));
  return preferred || firstCandidate;
}

function resolveCommandOnPath({ bin, env = process.env, platform = process.platform, encoding = "utf8", runSync = defaultRunSync }) {
  const lookupCommand = platform === "win32" ? "where.exe" : "which";
  const result = runSync(lookupCommand, [bin], {
    env,
    encoding,
  });

  if (result.error || result.status !== 0) {
    return "";
  }

  const candidates = parseWhereCandidates(result.stdout);
  if (platform === "win32") {
    return pickWindowsCandidate(candidates);
  }

  return candidates[0] || "";
}

function resolveExecutionMode(command) {
  return path.extname(command).toLowerCase() === ".cmd"
    ? OPENCLAW_EXECUTION_MODE_WINDOWS_CMD
    : OPENCLAW_EXECUTION_MODE_DIRECT;
}

function quoteWindowsCmdValue(value) {
  return `"${String(value ?? "")
    .replace(/"/g, "\"\"")
    .replace(/%/g, "%%")}"`;
}

function buildWindowsCmdCommand(command, args) {
  return [command, ...args].map(quoteWindowsCmdValue).join(" ");
}

function wrapWindowsCmdForCmdExe(command) {
  return `"${command}"`;
}

function quotePosixShellValue(value) {
  return `'${String(value ?? "").replace(/'/g, `'\"'\"'`)}'`;
}

function buildShellCommand(command, args, platform = process.platform) {
  if (platform === "win32") {
    return buildWindowsCmdCommand(command, args);
  }

  return [command, ...args].map(quotePosixShellValue).join(" ");
}

export function buildOpenClawInvocation({ resolvedCommand, executionMode, args = [] }) {
  if (executionMode === OPENCLAW_EXECUTION_MODE_WINDOWS_CMD) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", wrapWindowsCmdForCmdExe(buildWindowsCmdCommand(resolvedCommand, args))],
    };
  }

  return {
    command: resolvedCommand,
    args,
  };
}

export function resolveOpenClawCommandSpec({
  cliOpenclawBin = "",
  env = process.env,
  platform = process.platform,
  encoding = "utf8",
  runSync = defaultRunSync,
  runShellSync = defaultRunShellSync,
} = {}) {
  const requested = resolveRequestedCommand({ cliOpenclawBin, env });
  if (requested.explicit) {
    const executionMode = resolveExecutionMode(requested.command);
    const invocation = buildOpenClawInvocation({
      resolvedCommand: requested.command,
      executionMode,
      args: ["--version"],
    });
    const versionResult = runSync(invocation.command, invocation.args, {
      env,
      encoding,
    });

    return {
      requestedCommand: requested.command,
      resolvedCommand: requested.command,
      executionMode,
      versionResult,
      usedPathLookup: false,
    };
  }

  const directVersionResult = runSync(requested.command, ["--version"], {
    env,
    encoding,
  });

  if (directVersionResult.error?.code !== "ENOENT") {
    return {
      requestedCommand: requested.command,
      resolvedCommand: requested.command,
      executionMode: OPENCLAW_EXECUTION_MODE_DIRECT,
      versionResult: directVersionResult,
      usedPathLookup: false,
    };
  }

  const resolvedCommand = resolveCommandOnPath({
    bin: requested.command,
    env,
    encoding,
    platform,
    runSync,
  });

  if (!resolvedCommand) {
    return {
      requestedCommand: requested.command,
      resolvedCommand: requested.command,
      executionMode: OPENCLAW_EXECUTION_MODE_DIRECT,
      versionResult: {
        error: { code: "ENOENT" },
        status: null,
        stdout: "",
        stderr: "",
      },
      usedPathLookup: false,
    };
  }

  const executionMode = resolveExecutionMode(resolvedCommand);
  const versionResult = runShellSync(buildShellCommand(resolvedCommand, ["--version"], platform), {
    env,
    encoding,
  });

  return {
    requestedCommand: requested.command,
    resolvedCommand,
    executionMode,
    versionResult,
    usedPathLookup: true,
  };
}
