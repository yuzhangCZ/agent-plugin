#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { listTarEntries } from "./tar-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "..");

export const releaseDescriptorSchema = Object.freeze([
  "id",
  "packageRoot",
  "versionSource",
  "publish",
  "build",
  "release",
]);

export const releaseDescriptors = Object.freeze({
  "skill-qrcode-auth": Object.freeze({
    id: "skill-qrcode-auth",
    packageRoot: "packages/skill-qrcode-auth",
    versionSource: "package.json",
    publish: Object.freeze({
      distTagSource: "version",
      mode: "directory",
      readinessChecks: Object.freeze([
        Object.freeze({ type: "path-exists", relativePath: "." }),
        Object.freeze({ type: "file-exists", relativePath: "dist/index.js" }),
        Object.freeze({ type: "file-exists", relativePath: "dist/index.d.ts" }),
        Object.freeze({ type: "file-exists", relativePath: "package.json" }),
        Object.freeze({ type: "manifest-version-match", relativePath: "package.json" }),
      ]),
      root: ".",
    }),
    build: Object.freeze({
      preparePublishSteps: Object.freeze([]),
      requiresDefaultGatewayUrl: false,
      steps: Object.freeze([["pnpm", "--dir", "packages/skill-qrcode-auth", "run", "build"]]),
      verifyStep: Object.freeze(["pnpm", "--dir", "packages/skill-qrcode-auth", "run", "verify:core"]),
    }),
    release: Object.freeze({
      tagPrefix: "release/skill-qrcode-auth/v",
    }),
  }),
  "skill-plugin-cli": Object.freeze({
    id: "skill-plugin-cli",
    packageRoot: "packages/skill-plugin-cli",
    versionSource: "package.json",
    publish: Object.freeze({
      distTagSource: "version",
      mode: "tarball",
      readinessChecks: Object.freeze([
        Object.freeze({ type: "file-exists", relativePath: ".tmp/release-pack/{packFile}" }),
        Object.freeze({ type: "tarball-entry-exists", relativePath: ".tmp/release-pack/{packFile}", entry: "package/package.json" }),
        Object.freeze({ type: "tarball-entry-exists", relativePath: ".tmp/release-pack/{packFile}", entry: "package/README.md" }),
        Object.freeze({ type: "tarball-entry-exists", relativePath: ".tmp/release-pack/{packFile}", entry: "package/dist/cli.js" }),
        Object.freeze({ type: "tarball-entry-missing", relativePath: ".tmp/release-pack/{packFile}", entry: "package/dist/index.js" }),
        Object.freeze({ type: "tarball-no-entry-suffix", relativePath: ".tmp/release-pack/{packFile}", suffix: ".d.ts" }),
        Object.freeze({ type: "tarball-no-entry-suffix", relativePath: ".tmp/release-pack/{packFile}", suffix: ".map" }),
      ]),
      root: ".",
    }),
    build: Object.freeze({
      preparePublishSteps: Object.freeze([["npm", "pack", "--pack-destination", ".tmp/release-pack"]]),
      requiresDefaultGatewayUrl: false,
      steps: Object.freeze([["pnpm", "--dir", "packages/skill-plugin-cli", "run", "build"]]),
      verifyStep: Object.freeze(["pnpm", "--dir", "packages/skill-plugin-cli", "run", "verify:core"]),
    }),
    release: Object.freeze({
      tagPrefix: "release/skill-plugin-cli/v",
    }),
  }),
  "message-bridge": Object.freeze({
    id: "message-bridge",
    packageRoot: "plugins/message-bridge",
    versionSource: "package.json",
    publish: Object.freeze({
      distTagSource: "version",
      mode: "directory",
      readinessChecks: Object.freeze([
        Object.freeze({ type: "path-exists", relativePath: "." }),
        Object.freeze({ type: "file-exists", relativePath: "release/message-bridge.plugin.js" }),
        Object.freeze({ type: "manifest-version-match", relativePath: "package.json" }),
      ]),
      root: ".",
    }),
    build: Object.freeze({
      preparePublishSteps: Object.freeze([]),
      requiresDefaultGatewayUrl: true,
      steps: Object.freeze([["pnpm", "--dir", "plugins/message-bridge", "run", "build"]]),
      verifyStep: Object.freeze(["pnpm", "--dir", "plugins/message-bridge", "run", "verify:release"]),
    }),
    release: Object.freeze({
      tagPrefix: "release/message-bridge/v",
    }),
  }),
  "message-bridge-openclaw": Object.freeze({
    id: "message-bridge-openclaw",
    packageRoot: "plugins/message-bridge-openclaw",
    versionSource: "package.json",
    publish: Object.freeze({
      distTagSource: "version",
      mode: "directory",
      readinessChecks: Object.freeze([
        Object.freeze({ type: "path-exists", relativePath: "." }),
        Object.freeze({ type: "file-exists", relativePath: "index.js" }),
        Object.freeze({ type: "file-exists", relativePath: "package.json" }),
        Object.freeze({ type: "file-exists", relativePath: "openclaw.plugin.json" }),
        Object.freeze({ type: "file-exists", relativePath: "README.md" }),
        Object.freeze({ type: "manifest-version-match", relativePath: "package.json" }),
      ]),
      root: "bundle",
    }),
    build: Object.freeze({
      preparePublishSteps: Object.freeze([]),
      requiresDefaultGatewayUrl: true,
      steps: Object.freeze([["pnpm", "--dir", "plugins/message-bridge-openclaw", "run", "build"]]),
      verifyStep: Object.freeze(["pnpm", "--dir", "plugins/message-bridge-openclaw", "run", "verify:release"]),
    }),
    release: Object.freeze({
      tagPrefix: "release/message-bridge-openclaw/v",
    }),
  }),
});

const validTargets = new Set([...Object.keys(releaseDescriptors), "dual"]);
const validBumps = new Set(["patch", "minor", "major", "prerelease"]);
const validReleaseKinds = new Set(["stable", "prerelease"]);
const defaultPreid = "beta";
const defaultGatewayUrlFlag = "--default-gateway-url";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatCommand(command) {
  return command
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function cloneCommand(command) {
  return [...command];
}

function resolveExecutable(command) {
  if (process.platform !== "win32") {
    return command;
  }

  if (command === "pnpm" || command === "npm" || command === "npx") {
    return `${command}.cmd`;
  }

  return command;
}

function createProcessPorts(overrides = {}) {
  const fs = overrides.fs ?? {
    exists: existsSync,
    mkdir: (targetPath) => mkdirSync(targetPath, { recursive: true }),
    readJson: parseJsonFile,
    writeJson: writeJsonFile,
  };

  const inspectDependencies =
    overrides.inspectDependencies ?? ((target) => inspectManifestDependencies(target, fs, exec));

  const exec =
    overrides.exec ??
    ((command, args, options = {}) => {
      const resolvedCommand = resolveExecutable(command);
      const output = execFileSync(resolvedCommand, args, {
        cwd: options.cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(options.env ?? {}),
        },
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(resolvedCommand),
        stdio: options.stdio ?? "pipe",
      });

      return typeof output === "string" ? output.trim() : "";
    });

  return {
    fs,
    exec,
    inspectDependencies,
    listTarEntries: overrides.listTarEntries ?? listTarEntries,
  };
}

function getDescriptor(target) {
  const descriptor = releaseDescriptors[target];
  if (!descriptor) {
    throw new Error(`unknown release target: ${target}`);
  }

  for (const key of releaseDescriptorSchema) {
    if (!(key in descriptor)) {
      throw new Error(`release descriptor ${target} is missing required field: ${key}`);
    }
  }

  return descriptor;
}

function toPackFilename(packageName, version) {
  return `${packageName.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

export function parseSemver(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    throw new Error(`invalid semver: ${version}`);
  }

  const prerelease = match[4] ? match[4].split(".") : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

export function formatSemver(version) {
  const suffix = version.prerelease.length > 0 ? `-${version.prerelease.join(".")}` : "";
  return `${version.major}.${version.minor}.${version.patch}${suffix}`;
}

function isPrerelease(version) {
  return version.prerelease.length > 0;
}

function isNumericIdentifier(value) {
  return /^\d+$/.test(value);
}

export function determineDistTag(version) {
  const parsed = typeof version === "string" ? parseSemver(version) : version;
  return parsed.prerelease[0] ?? "latest";
}

export function computeNextVersion(currentVersion, bump, preid = defaultPreid) {
  const parsed = parseSemver(currentVersion);

  if (!validBumps.has(bump)) {
    throw new Error(`unsupported bump type: ${bump}`);
  }

  if (bump === "major") {
    return formatSemver({ major: parsed.major + 1, minor: 0, patch: 0, prerelease: [] });
  }

  if (bump === "minor") {
    return formatSemver({ major: parsed.major, minor: parsed.minor + 1, patch: 0, prerelease: [] });
  }

  if (bump === "patch") {
    return formatSemver({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + 1, prerelease: [] });
  }

  if (!isPrerelease(parsed)) {
    return formatSemver({
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch + 1,
      prerelease: [preid, "0"],
    });
  }

  if (parsed.prerelease[0] !== preid) {
    return formatSemver({
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch,
      prerelease: [preid, "0"],
    });
  }

  const nextPrerelease = [...parsed.prerelease];
  const lastIndex = nextPrerelease.length - 1;

  if (lastIndex >= 1 && isNumericIdentifier(nextPrerelease[lastIndex])) {
    nextPrerelease[lastIndex] = String(Number(nextPrerelease[lastIndex]) + 1);
  } else {
    nextPrerelease.push("0");
  }

  return formatSemver({
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: nextPrerelease,
  });
}

function inferReleaseKind(version, bump, explicitRelease) {
  if (explicitRelease) {
    return explicitRelease;
  }

  if (typeof version === "string") {
    return isPrerelease(parseSemver(version)) ? "prerelease" : "stable";
  }

  if (bump === "prerelease") {
    return "prerelease";
  }

  return "stable";
}

function normalizeArgv(argv) {
  return argv.filter((arg, index) => !(arg === "--" && index >= 0));
}

function getPackageScope(packageName) {
  if (typeof packageName !== "string" || !packageName.startsWith("@") || !packageName.includes("/")) {
    return null;
  }

  return packageName.split("/")[0];
}

function normalizeRegistryValue(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "undefined" || normalized === "null") {
    return null;
  }

  return normalized;
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function validateDefaultGatewayUrl(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error("default gateway url is required; pass --default-gateway-url <url> so MB_DEFAULT_GATEWAY_URL is set before build");
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("default gateway url must be a valid WebSocket URL using ws:// or wss://");
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("default gateway url must use ws:// or wss://");
  }

  return normalized;
}

function readOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

export function parseReleaseLocalArgs(argv) {
  const args = normalizeArgv(argv);
  const parsed = {
    allowDirty: false,
    bridgeVersion: null,
    bump: null,
    defaultGatewayUrl: null,
    dryRun: false,
    help: false,
    installDeps: false,
    installDepsUpdateLockfile: false,
    openclawVersion: null,
    positionalTarget: null,
    preid: defaultPreid,
    push: false,
    release: null,
    skipGit: false,
    skipPublish: false,
    skipVerify: false,
    target: null,
    version: null,
  };

  const assignTarget = (value, source) => {
    if (!value) {
      throw new Error(`${source} target cannot be empty`);
    }

    if (parsed.target && parsed.target !== value) {
      throw new Error(`conflicting release targets: ${parsed.target} vs ${value}`);
    }

    if (parsed.positionalTarget && parsed.positionalTarget !== value) {
      throw new Error(`conflicting release targets: ${parsed.positionalTarget} vs ${value}`);
    }

    if (source === "positional") {
      parsed.positionalTarget = value;
    } else {
      parsed.target = value;
    }
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--dry-run" || arg === "-n") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--skip-publish") {
      parsed.skipPublish = true;
      continue;
    }

    if (arg === "--skip-git") {
      parsed.skipGit = true;
      continue;
    }

    if (arg === "--skip-verify") {
      parsed.skipVerify = true;
      continue;
    }

    if (arg === "--push") {
      parsed.push = true;
      continue;
    }

    if (arg === "--allow-dirty") {
      parsed.allowDirty = true;
      continue;
    }

    if (arg === "--install-deps") {
      parsed.installDeps = true;
      continue;
    }

    if (arg === "--install-deps-update-lockfile") {
      parsed.installDepsUpdateLockfile = true;
      continue;
    }

    if (arg === "--target") {
      assignTarget(readOptionValue(args, index, "--target"), "option");
      index += 1;
      continue;
    }

    if (arg.startsWith("--target=")) {
      assignTarget(arg.slice("--target=".length), "option");
      continue;
    }

    if (arg === "--version") {
      parsed.version = readOptionValue(args, index, "--version");
      index += 1;
      continue;
    }

    if (arg.startsWith("--version=")) {
      parsed.version = arg.slice("--version=".length);
      continue;
    }

    if (arg === "--bridge-version") {
      parsed.bridgeVersion = readOptionValue(args, index, "--bridge-version");
      index += 1;
      continue;
    }

    if (arg.startsWith("--bridge-version=")) {
      parsed.bridgeVersion = arg.slice("--bridge-version=".length);
      continue;
    }

    if (arg === "--openclaw-version") {
      parsed.openclawVersion = readOptionValue(args, index, "--openclaw-version");
      index += 1;
      continue;
    }

    if (arg.startsWith("--openclaw-version=")) {
      parsed.openclawVersion = arg.slice("--openclaw-version=".length);
      continue;
    }

    if (arg === defaultGatewayUrlFlag) {
      parsed.defaultGatewayUrl = readOptionValue(args, index, defaultGatewayUrlFlag);
      index += 1;
      continue;
    }

    if (arg.startsWith(`${defaultGatewayUrlFlag}=`)) {
      parsed.defaultGatewayUrl = arg.slice(`${defaultGatewayUrlFlag}=`.length);
      continue;
    }

    if (arg === "--bump") {
      parsed.bump = readOptionValue(args, index, "--bump");
      index += 1;
      continue;
    }

    if (arg.startsWith("--bump=")) {
      parsed.bump = arg.slice("--bump=".length);
      continue;
    }

    if (arg === "--preid") {
      parsed.preid = readOptionValue(args, index, "--preid");
      index += 1;
      continue;
    }

    if (arg.startsWith("--preid=")) {
      parsed.preid = arg.slice("--preid=".length);
      continue;
    }

    if (arg === "--release") {
      parsed.release = readOptionValue(args, index, "--release");
      index += 1;
      continue;
    }

    if (arg.startsWith("--release=")) {
      parsed.release = arg.slice("--release=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    }

    assignTarget(arg, "positional");
  }

  const target = parsed.target ?? parsed.positionalTarget;
  if (parsed.help) {
    return {
      ...parsed,
      target: target ?? null,
    };
  }

  if (!target) {
    throw new Error("missing release target");
  }

  if (!validTargets.has(target)) {
    throw new Error(`unknown release target: ${target}`);
  }

  if (parsed.version && parsed.bump) {
    throw new Error("--version and --bump cannot be used together");
  }

  if (parsed.push && parsed.skipGit) {
    throw new Error("--push cannot be combined with --skip-git");
  }

  if (parsed.push && parsed.skipPublish) {
    throw new Error("--push cannot be combined with --skip-publish");
  }

  if (parsed.installDeps && parsed.installDepsUpdateLockfile) {
    throw new Error("--install-deps and --install-deps-update-lockfile cannot be used together");
  }

  if (!validReleaseKinds.has(parsed.release ?? inferReleaseKind(parsed.version, parsed.bump, null))) {
    throw new Error(`invalid --release value: ${parsed.release}`);
  }

  if (parsed.bump && !validBumps.has(parsed.bump)) {
    throw new Error(`invalid --bump value: ${parsed.bump}`);
  }

  if (target === "dual") {
    if (parsed.version) {
      throw new Error("dual releases require --bridge-version and --openclaw-version, not --version");
    }

    if (parsed.bump && (parsed.bridgeVersion || parsed.openclawVersion)) {
      throw new Error("dual releases cannot mix --bump with explicit package versions");
    }

    if (!parsed.bump && !(parsed.bridgeVersion && parsed.openclawVersion)) {
      throw new Error("dual releases require --bump or both --bridge-version and --openclaw-version");
    }

    if ((parsed.bridgeVersion && !parsed.openclawVersion) || (!parsed.bridgeVersion && parsed.openclawVersion)) {
      throw new Error("dual releases require both --bridge-version and --openclaw-version");
    }
  } else {
    if (parsed.bridgeVersion || parsed.openclawVersion) {
      throw new Error("--bridge-version and --openclaw-version are valid only for --target dual");
    }

    if (!parsed.version && !parsed.bump) {
      throw new Error("single-target releases require --version or --bump");
    }
  }

  if (parsed.version) {
    const explicit = parseSemver(parsed.version);
    const explicitKind = isPrerelease(explicit) ? "prerelease" : "stable";
    if (parsed.release && parsed.release !== explicitKind) {
      throw new Error(`--release ${parsed.release} conflicts with explicit version ${parsed.version}`);
    }
    if (parsed.preid !== defaultPreid && explicitKind === "stable") {
      throw new Error("--preid requires a prerelease version or --bump prerelease");
    }
    if (explicitKind === "prerelease" && parsed.preid !== defaultPreid && explicit.prerelease[0] !== parsed.preid) {
      throw new Error(`--preid ${parsed.preid} does not match explicit prerelease version ${parsed.version}`);
    }
  }

  if (parsed.bridgeVersion) {
    const bridgeKind = isPrerelease(parseSemver(parsed.bridgeVersion)) ? "prerelease" : "stable";
    if (parsed.release && parsed.release !== bridgeKind) {
      throw new Error(`--release ${parsed.release} conflicts with --bridge-version ${parsed.bridgeVersion}`);
    }
  }

  if (parsed.openclawVersion) {
    const openclawKind = isPrerelease(parseSemver(parsed.openclawVersion)) ? "prerelease" : "stable";
    if (parsed.release && parsed.release !== openclawKind) {
      throw new Error(`--release ${parsed.release} conflicts with --openclaw-version ${parsed.openclawVersion}`);
    }
  }

  if (parsed.release === "prerelease" && !parsed.bump && !parsed.version && !parsed.bridgeVersion && !parsed.openclawVersion) {
    throw new Error("--release prerelease requires a prerelease version or --bump prerelease");
  }

  return {
    ...parsed,
    target,
  };
}

function resolveTargetVersion(currentVersion, options) {
  if (options.version) {
    return options.version;
  }

  return computeNextVersion(currentVersion, options.bump, options.preid);
}

function resolveReleaseTarget(target, repoRoot, fs) {
  const descriptor = getDescriptor(target);
  const packageRoot = path.resolve(repoRoot, descriptor.packageRoot);
  const versionSourcePath = path.join(packageRoot, descriptor.versionSource);
  const manifest = fs.readJson(versionSourcePath);

  if (!isObject(manifest)) {
    throw new Error(`invalid package manifest: ${versionSourcePath}`);
  }

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`missing package version in ${versionSourcePath}`);
  }

  const packageName = typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : target;
  const publishRootAbsolute = path.resolve(packageRoot, descriptor.publish.root);
  const publishRootRelative = path.relative(repoRoot, publishRootAbsolute) || ".";

  return {
    ...descriptor,
    buildSteps: descriptor.build.steps,
    packageName,
    currentVersion: manifest.version,
    packageRootAbsolute: packageRoot,
    preparePublishSteps: descriptor.build.preparePublishSteps,
    publishMode: descriptor.publish.mode,
    publishRootAbsolute,
    publishRootRelative,
    releaseReadinessChecks: descriptor.publish.readinessChecks,
    requiresDefaultGatewayUrl: descriptor.build.requiresDefaultGatewayUrl,
    tagPrefix: descriptor.release.tagPrefix,
    distTagSource: descriptor.publish.distTagSource,
    verifyStep: descriptor.build.verifyStep,
    versionSourceAbsolute: versionSourcePath,
    versionSourceRelative: path.relative(repoRoot, versionSourcePath),
  };
}

function normalizeRepoRelativePath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function resolveStatusPath(statusLine) {
  const candidate = statusLine.slice(3).trim();
  const renameIndex = candidate.lastIndexOf(" -> ");
  return normalizeRepoRelativePath(renameIndex >= 0 ? candidate.slice(renameIndex + 4) : candidate);
}

function createGeneratedPathPrefixes() {
  const prefixes = new Set([".tmp", "logs"]);

  for (const descriptor of Object.values(releaseDescriptors)) {
    const packageRoot = normalizeRepoRelativePath(descriptor.packageRoot);
    prefixes.add(`${packageRoot}/.tmp`);
    prefixes.add(`${packageRoot}/logs`);
    prefixes.add(`${packageRoot}/dist`);
    prefixes.add(`${packageRoot}/release`);
    prefixes.add(`${packageRoot}/bundle`);

    if (descriptor.publish.root !== ".") {
      prefixes.add(normalizeRepoRelativePath(path.join(descriptor.packageRoot, descriptor.publish.root)));
    }
  }

  return [...prefixes].sort();
}

const generatedPathPrefixes = createGeneratedPathPrefixes();

function isGeneratedStatusPath(relativePath) {
  return generatedPathPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
}

function filterWorkingTreeStatus(statusOutput) {
  return statusOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .filter((line) => !isGeneratedStatusPath(resolveStatusPath(line)))
    .join("\n");
}

function getWorkingTreeStatus(repoRoot, exec) {
  const rawStatus = exec("git", ["status", "--short", "--untracked-files=all"], { cwd: repoRoot });
  return filterWorkingTreeStatus(rawStatus);
}

function tagExists(repoRoot, exec, tagName) {
  try {
    exec("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function toCommitMessage(targets) {
  if (targets.length === 1) {
    return `release(${targets[0].id}): v${targets[0].targetVersion}`;
  }

  return `release(dual): bridge v${targets[0].targetVersion}, openclaw v${targets[1].targetVersion}`;
}

export function evaluatePublishReadiness(targetPlan, options = {}) {
  const ports = createProcessPorts(options);
  const fs = options.fs ?? ports.fs;
  const executedChecks = [];
  const publishRoot = targetPlan.publishRootAbsolute;
  let tarballEntries = null;

  for (const check of targetPlan.releaseReadinessChecks) {
    const relativePath = resolveReadinessRelativePath(check.relativePath ?? ".", targetPlan);
    if (check.type === "path-exists") {
      const absolutePath = path.resolve(publishRoot, relativePath);
      const ok = fs.exists(absolutePath);
      executedChecks.push({
        check: `path exists: ${path.relative(targetPlan.repoRoot, absolutePath) || "."}`,
        ok,
      });
      continue;
    }

    if (check.type === "file-exists") {
      const absolutePath = path.resolve(publishRoot, relativePath);
      const ok = fs.exists(absolutePath);
      executedChecks.push({
        check: `file exists: ${path.relative(targetPlan.repoRoot, absolutePath)}`,
        ok,
      });
      continue;
    }

    if (check.type === "manifest-version-match") {
      const manifestPath = path.resolve(publishRoot, relativePath);
      let ok = false;
      try {
        const manifest = fs.readJson(manifestPath);
        ok = isObject(manifest) && manifest.version === targetPlan.targetVersion;
      } catch {
        ok = false;
      }
      executedChecks.push({
        check: `manifest version matches ${targetPlan.targetVersion}: ${path.relative(targetPlan.repoRoot, manifestPath)}`,
        ok,
      });
      continue;
    }

    if (check.type === "tarball-entry-exists" || check.type === "tarball-entry-missing" || check.type === "tarball-no-entry-suffix") {
      const tarballPath = path.resolve(publishRoot, relativePath);
      if (tarballEntries === null) {
        tarballEntries = ports.listTarEntries(tarballPath);
      }

      if (check.type === "tarball-entry-exists") {
        executedChecks.push({
          check: `tarball entry exists: ${check.entry} in ${path.relative(targetPlan.repoRoot, tarballPath)}`,
          ok: tarballEntries.includes(check.entry),
        });
        continue;
      }

      if (check.type === "tarball-entry-missing") {
        executedChecks.push({
          check: `tarball entry missing: ${check.entry} in ${path.relative(targetPlan.repoRoot, tarballPath)}`,
          ok: !tarballEntries.includes(check.entry),
        });
        continue;
      }

      executedChecks.push({
        check: `tarball entry suffix absent: ${check.suffix} in ${path.relative(targetPlan.repoRoot, tarballPath)}`,
        ok: !tarballEntries.some((entry) => entry.endsWith(check.suffix)),
      });
      continue;
    }

    throw new Error(`unsupported readiness check type: ${check.type}`);
  }

  return {
    executedChecks,
    releaseReady: executedChecks.every((entry) => entry.ok),
    resolvedDistTag: targetPlan.distTag,
    resolvedPublishRoot: targetPlan.publishSourceRelative,
    resolvedVersion: targetPlan.targetVersion,
  };
}

function resolveReadinessRelativePath(relativePath, targetPlan) {
  return String(relativePath ?? ".").replaceAll("{packFile}", targetPlan.publishArtifactFileName ?? "");
}

export function createReleasePlan(input = {}, overrides = {}) {
  const repoRoot = overrides.repoRoot ?? input.repoRoot ?? defaultRepoRoot;
  const { fs, exec } = createProcessPorts(overrides);
  const parsed = input.target ? input : parseReleaseLocalArgs(input.argv ?? []);
  const targetIds = parsed.target === "dual" ? ["message-bridge", "message-bridge-openclaw"] : [parsed.target];
  const targets = targetIds.map((targetId) => {
    const resolved = resolveReleaseTarget(targetId, repoRoot, fs);
    const explicitVersion =
      targetId === "message-bridge"
        ? parsed.bridgeVersion ?? parsed.version
        : targetId === "message-bridge-openclaw"
          ? parsed.openclawVersion ?? parsed.version
          : parsed.version;
    const targetVersion = resolveTargetVersion(resolved.currentVersion, {
      bump: parsed.bump,
      preid: parsed.preid,
      version: explicitVersion,
    });
    const releaseKind = inferReleaseKind(targetVersion, parsed.bump, parsed.release);

    if (releaseKind === "stable" && isPrerelease(parseSemver(targetVersion))) {
      throw new Error(`stable releases cannot use prerelease version ${targetVersion}`);
    }

    if (releaseKind === "prerelease" && !isPrerelease(parseSemver(targetVersion))) {
      throw new Error(`prerelease releases require a prerelease version: ${targetVersion}`);
    }

    if (targetVersion === resolved.currentVersion) {
      throw new Error(`target version must change for ${targetId}; current version is already ${targetVersion}`);
    }

    return {
      ...resolved,
      distTag: determineDistTag(targetVersion),
      publishArtifactFileName: resolved.publishMode === "tarball" ? toPackFilename(resolved.packageName, targetVersion) : null,
      releaseKind,
      repoRoot,
      tagName: `${resolved.tagPrefix}${targetVersion}`,
      targetVersion,
    };
  });

  for (const target of targets) {
    target.publishArtifactAbsolute = target.publishArtifactFileName
      ? path.resolve(target.packageRootAbsolute, ".tmp", "release-pack", target.publishArtifactFileName)
      : null;
    target.publishSourceRelative = target.publishArtifactFileName
      ? path.relative(repoRoot, target.publishArtifactAbsolute)
      : target.publishRootRelative;
  }

  const blockers = [];
  const warnings = [];
  const workingTreeStatus = parsed.skipGit ? "" : getWorkingTreeStatus(repoRoot, exec);
  if (!parsed.skipGit && !parsed.allowDirty && workingTreeStatus.trim().length > 0) {
    blockers.push("working tree is not clean; rerun with --allow-dirty only if you intend to keep unrelated local changes");
  }

  if (!parsed.skipGit) {
    for (const target of targets) {
      if (tagExists(repoRoot, exec, target.tagName)) {
        blockers.push(`release tag already exists: ${target.tagName}`);
      }
    }
  }

  if (targets.length > 1) {
    warnings.push("dual releases are non-atomic; the first package may already be published if the second one fails.");
  }

  if (parsed.skipVerify) {
    warnings.push(
      "verify steps are being skipped by user request; publish may continue without verify:release safeguards.",
    );
  }

  warnings.push("npm publish and git commit/tag are non-atomic; publish can succeed even if later git steps fail.");

  return {
    actions: {
      commit: !parsed.skipGit,
      publish: !parsed.skipPublish,
      push: !parsed.skipGit && parsed.push,
      tag: !parsed.skipGit,
    },
    blockers,
    dryRun: parsed.dryRun,
    help: false,
    parsed,
    repoRoot,
    targets,
    warnings,
    workingTreeStatus,
  };
}

function formatTargetPlan(target, options = {}) {
  const verifyLabel = options.skipVerify ? "skipped (--skip-verify)" : formatCommand(target.verifyStep);
  return [
    `- ${target.id}: ${target.packageName}`,
    `  current version: ${target.currentVersion}`,
    `  target version: ${target.targetVersion}`,
    `  release kind: ${target.releaseKind}`,
    `  dist-tag: ${target.distTag}`,
    `  publish root: ${target.publishSourceRelative}`,
    `  tag: ${target.tagName}`,
    `  build steps: ${target.buildSteps.map((command) => formatCommand(command)).join(" ; ")}`,
    `  verify step: ${verifyLabel}`,
  ].join("\n");
}

export function formatReleasePlan(plan) {
  const skipVerify = Boolean(plan.parsed?.skipVerify);
  const defaultGatewayUrl = normalizeOptionalString(plan.parsed?.defaultGatewayUrl);
  const lines = [
    "Local Release Plan",
    `repo root: ${plan.repoRoot}`,
    `mode: ${plan.targets.length > 1 ? "dual (non-atomic)" : "single-target"}`,
    `dry run: ${plan.dryRun ? "yes" : "no"}`,
    `publish: ${plan.actions.publish ? "yes" : "no"}`,
    `verify: ${skipVerify ? "no" : "yes"}`,
    `git commit/tag: ${plan.actions.commit ? "yes" : "no"}`,
    `push remote: ${plan.actions.push ? "yes" : "no"}`,
    `default gateway url: ${defaultGatewayUrl ?? "missing"}`,
    "",
    "Targets:",
    ...plan.targets.map((target) => formatTargetPlan(target, { skipVerify })),
    "",
    "Publish readiness contract:",
    skipVerify
      ? "- releaseReady is evaluated after build completes; verify was skipped by user request"
      : "- releaseReady is evaluated only after build and verify steps complete",
    "- readiness output includes resolvedVersion, resolvedDistTag, resolvedPublishRoot, and executedChecks",
  ];

  if (plan.blockers.length > 0) {
    lines.push("", "Blockers:");
    for (const blocker of plan.blockers) {
      lines.push(`- ${blocker}`);
    }
  }

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of plan.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatReadiness(readiness) {
  const lines = [
    `publish readiness: ${readiness.releaseReady ? "ready" : "blocked"}`,
    `resolvedVersion: ${readiness.resolvedVersion}`,
    `resolvedDistTag: ${readiness.resolvedDistTag}`,
    `resolvedPublishRoot: ${readiness.resolvedPublishRoot}`,
    "executedChecks:",
  ];

  for (const entry of readiness.executedChecks) {
    lines.push(`- ${entry.ok ? "ok" : "fail"}: ${entry.check}`);
  }

  return `${lines.join("\n")}\n`;
}

export function formatHelp() {
  return `
Usage:
  pnpm release:local -- --target <skill-qrcode-auth|skill-plugin-cli|message-bridge|message-bridge-openclaw|dual> [options]
  pnpm release:plan -- --target <skill-qrcode-auth|skill-plugin-cli|message-bridge|message-bridge-openclaw|dual> [options]

Required version input:
  Single target:
    --version <semver>
    --bump <patch|minor|major|prerelease>
  Dual target:
    --bump <patch|minor|major|prerelease>
    --bridge-version <semver> --openclaw-version <semver>

Options:
  --target <name>                 Release target or "dual"
  --version <semver>              Explicit version for single-target release
  --bridge-version <semver>       Explicit message-bridge version for dual release
  --openclaw-version <semver>     Explicit message-bridge-openclaw version for dual release
  --default-gateway-url <url>     WebSocket gateway url injected into official release builds
  --bump <type>                   patch | minor | major | prerelease
  --preid <name>                  Prerelease identifier, default: beta
  --release <stable|prerelease>   Explicit release kind
  --dry-run                       Print the release plan without mutating npm or git
  --skip-publish                  Build and verify by default, but skip npm publish
  --skip-verify                   Build and evaluate readiness, but skip verify:release
  --skip-git                      Publish without local commit/tag
  --push                          Push branch and new tags after local commit/tag
  --install-deps                  Auto-install packages for the dependency presence sanity check with pnpm install --frozen-lockfile
  --install-deps-update-lockfile  Auto-install packages for the dependency presence sanity check with pnpm install
  --allow-dirty                   Allow running from a dirty worktree
  --help, -h                      Print this help

Defaults:
  - npm publish runs by default
  - git commit and tag are local by default
  - remote push only runs with --push
  - --skip-publish cannot be combined with --push
  - dependency presence sanity checks run before any build or verify step
  - the presence sanity check only looks for clearly missing packages before build
  - builds run by default; verify also runs by default unless --skip-verify is used
  - --skip-verify only skips verify:release; it does not skip build or readiness checks
  - release correctness is enforced by build, readiness, and verify unless you explicitly skip verify
  - missing packages fail fast unless an install flag is provided
  - --install-deps preserves the lockfile; --install-deps-update-lockfile may modify it
  - gateway-dependent targets require --default-gateway-url so MB_DEFAULT_GATEWAY_URL is injected before build
  - skill-qrcode-auth publishes from packages/skill-qrcode-auth
  - skill-plugin-cli publishes from packages/skill-plugin-cli/.tmp/release-pack/<package-version>.tgz
  - message-bridge publishes from plugins/message-bridge
  - message-bridge-openclaw publishes from plugins/message-bridge-openclaw/bundle
  - dual releases are non-atomic

Examples:
  pnpm release:plan -- --target skill-qrcode-auth --bump patch
  pnpm release:local -- --target skill-qrcode-auth --version 0.1.0
  pnpm release:plan -- --target skill-plugin-cli --bump patch
  pnpm release:local -- --target skill-plugin-cli --version 0.1.0
  pnpm release:plan -- --target message-bridge --bump patch
  pnpm release:local -- --target message-bridge --version 1.2.0 --default-gateway-url wss://gateway.example.com/ws/agent
  pnpm release:local -- --target message-bridge --version 1.2.0 --install-deps
  pnpm release:local -- --target message-bridge --bump prerelease --preid beta
  pnpm release:local -- --target message-bridge-openclaw --version 0.2.0 --skip-publish --default-gateway-url wss://gateway.example.com/ws/agent
  pnpm release:local -- --target dual --bridge-version 1.3.0 --openclaw-version 0.2.0 --default-gateway-url wss://gateway.example.com/ws/agent
  pnpm release:local -- --target message-bridge --bump patch --push --default-gateway-url wss://gateway.example.com/ws/agent
`.trimStart();
}

function runCommand(exec, command, cwd, env) {
  const resolvedEnv = command[0] === "npm"
    ? createNpmCommandEnv(cwd, env)
    : env;
  return exec(command[0], command.slice(1), {
    cwd,
    env: resolvedEnv,
    stdio: "inherit",
  });
}

function ensurePreparePublishTarget(fs, target) {
  if (!target.publishArtifactAbsolute) {
    return;
  }

  // tarball 发布需要先准备输出目录，npm pack 不会自动创建 --pack-destination。
  fs.mkdir(path.dirname(target.publishArtifactAbsolute));
}

function createNpmCommandEnv(repoRoot, env = {}) {
  return {
    ...env,
    NPM_CONFIG_CACHE: path.resolve(repoRoot, ".tmp", "release-local", "npm-cache"),
  };
}

function ensureNpmCommandEnvironment(fs, repoRoot) {
  fs.mkdir(path.resolve(repoRoot, ".tmp", "release-local", "npm-cache"));
}

function collectManifestDependencyNames(manifest) {
  const dependencyFields = ["dependencies", "devDependencies"];
  const names = new Set();

  for (const field of dependencyFields) {
    const entries = manifest[field];
    if (!isObject(entries)) {
      continue;
    }

    for (const dependencyName of Object.keys(entries)) {
      names.add(dependencyName);
    }
  }

  return [...names].sort();
}

export function inspectManifestDependencies(target, fs, exec) {
  const manifest = fs.readJson(target.versionSourceAbsolute);
  const dependencyNames = collectManifestDependencyNames(manifest);

  if (dependencyNames.length === 0) {
    return {
      missingPackages: [],
      ok: true,
      targetId: target.id,
    };
  }

  const checkScript = `
import { createRequire } from "node:module";
import path from "node:path";

const dependencyNames = JSON.parse(process.argv[1]);
const requireFromPackage = createRequire(path.join(process.cwd(), "package.json"));
const missingPackages = [];

for (const dependencyName of dependencyNames) {
  try {
    await import.meta.resolve(dependencyName);
    continue;
  } catch {}

  try {
    requireFromPackage.resolve(dependencyName);
    continue;
  } catch {
    try {
      requireFromPackage.resolve(\`\${dependencyName}/package.json\`);
      continue;
    } catch {}
  }

  missingPackages.push(dependencyName);
}

process.stdout.write(JSON.stringify({ missingPackages }));
`.trim();

  const output = exec(
    "node",
    ["--input-type=module", "-e", checkScript, JSON.stringify(dependencyNames)],
    {
      cwd: target.packageRootAbsolute,
      stdio: "pipe",
    },
  );

  const parsedOutput = output ? JSON.parse(output) : { missingPackages: [] };
  const missingPackages = Array.isArray(parsedOutput.missingPackages) ? parsedOutput.missingPackages : [];

  return {
    missingPackages,
    ok: missingPackages.length === 0,
    targetId: target.id,
  };
}

function getDependencyInstallMode(parsed) {
  if (parsed.installDepsUpdateLockfile) {
    return "update-lockfile";
  }

  if (parsed.installDeps) {
    return "frozen-lockfile";
  }

  return "none";
}

function formatMissingDependenciesMessage(failures) {
  const summary = failures
    .map((failure) => `${failure.targetId}: ${failure.missingPackages.slice(0, 5).join(", ")}`)
    .join("; ");

  return `dependency presence sanity check failed before build; unresolved packages: ${summary}. This preflight only verifies package presence before build. Prefer rerunning with --install-deps, run pnpm install --frozen-lockfile manually, or use --install-deps-update-lockfile if updating the lockfile is intentional.`;
}

function prepareDependencies(plan, ports, stdout) {
  const installMode = getDependencyInstallMode(plan.parsed);
  const inspectDependencies = ports.inspectDependencies ?? ((target) => inspectManifestDependencies(target, ports.fs, ports.exec));

  const checkTargets = () =>
    plan.targets
      .map((target) => inspectDependencies(target))
      .filter((result) => !result.ok);

  let failures = checkTargets();
  if (failures.length === 0) {
    stdout.write("dependency presence check: passed\n");
    return;
  }

  stdout.write("dependency presence check: failed\n");
  if (installMode === "none") {
    throw new Error(formatMissingDependenciesMessage(failures));
  }

  const installCommand =
    installMode === "frozen-lockfile" ? ["pnpm", "install", "--frozen-lockfile"] : ["pnpm", "install"];
  stdout.write(`dependency presence install: ${formatCommand(installCommand)}\n`);
  runCommand(ports.exec, installCommand, plan.repoRoot);

  failures = checkTargets();
  if (failures.length === 0) {
    stdout.write("dependency presence check: passed\n");
    return;
  }

  stdout.write("dependency presence check: failed\n");
  throw new Error(formatMissingDependenciesMessage(failures));
}

function readRegistry(exec, repoRoot) {
  return exec("npm", ["config", "get", "registry", "--force"], {
    cwd: repoRoot,
    env: createNpmCommandEnv(repoRoot),
    stdio: "pipe",
  });
}

function resolvePublishRegistry(exec, repoRoot, packageName) {
  const packageScope = getPackageScope(packageName);
  if (packageScope) {
    const scopedRegistry = normalizeRegistryValue(
      exec("npm", ["config", "get", `${packageScope}:registry`, "--force"], {
        cwd: repoRoot,
        env: createNpmCommandEnv(repoRoot),
        stdio: "pipe",
      }),
    );

    if (scopedRegistry) {
      return scopedRegistry;
    }
  }

  const defaultRegistry = normalizeRegistryValue(readRegistry(exec, repoRoot));
  if (!defaultRegistry) {
    throw new Error(`unable to resolve publish registry for ${packageName}`);
  }

  return defaultRegistry;
}

function readWhoAmI(exec, repoRoot, registry) {
  return exec("npm", ["whoami", "--registry", registry, "--force"], {
    cwd: repoRoot,
    env: createNpmCommandEnv(repoRoot),
    stdio: "pipe",
  });
}

function updateManifestVersion(fs, manifestPath, targetVersion) {
  const manifest = fs.readJson(manifestPath);
  manifest.version = targetVersion;
  fs.writeJson(manifestPath, manifest);
}

function printRuntimeHeader(stdout, plan, registry, whoami) {
  stdout.write(`${formatReleasePlan(plan)}\n`);
  stdout.write("Registry Context\n");
  stdout.write(`registry: ${registry}\n`);
  stdout.write(`registry whoami: ${whoami}\n`);
  if (plan.parsed.skipVerify) {
    stdout.write("verify skipped by user request (--skip-verify)\n");
  }
  stdout.write("\n");
}

function getCurrentBranch(exec, repoRoot) {
  const branch = exec("git", ["branch", "--show-current"], {
    cwd: repoRoot,
    stdio: "pipe",
  });

  if (!branch) {
    throw new Error("cannot push from a detached HEAD");
  }

  return branch;
}

function printPublishedFact(stdout, target) {
  stdout.write(
    `[published] ${target.id} ${target.targetVersion} -> ${target.packageName} (${target.distTag}) from ${target.publishSourceRelative}\n`,
  );
}

function restoreManifestVersion(fs, manifestPath, version) {
  const manifest = fs.readJson(manifestPath);
  manifest.version = version;
  fs.writeJson(manifestPath, manifest);
}

function createReleaseBuildEnv(plan) {
  const requiresGatewayUrl = plan.targets.some((target) => target.requiresDefaultGatewayUrl);
  if (!requiresGatewayUrl) {
    return {};
  }

  const defaultGatewayUrl = validateDefaultGatewayUrl(plan.parsed?.defaultGatewayUrl);
  return {
    MB_DEFAULT_GATEWAY_URL: defaultGatewayUrl,
  };
}

function maybeInjectFailure(target, stage) {
  const configuredTarget = process.env.RELEASE_LOCAL_FAIL_TARGET;
  const configuredStage = process.env.RELEASE_LOCAL_FAIL_STAGE;
  if (!configuredTarget || !configuredStage) {
    return;
  }

  if (configuredTarget !== target.id || configuredStage !== stage) {
    return;
  }

  throw new Error(`injected failure for ${target.id} at ${stage}`);
}

export function isCliEntry(importMetaUrl, argvEntry, cwd = process.cwd()) {
  if (!argvEntry) {
    return false;
  }

  const importMetaPath = normalizeCliEntryPathFromUrl(importMetaUrl);
  const argvPath = normalizeCliArgvEntry(argvEntry, importMetaPath.kind, cwd);
  return importMetaPath.kind === argvPath.kind && importMetaPath.value === argvPath.value;
}

function normalizeCliEntryPathFromUrl(importMetaUrl) {
  const url = new URL(importMetaUrl);
  if (/^\/[A-Za-z]:\//.test(url.pathname)) {
    return {
      kind: "win32",
      value: path.win32.normalize(url.pathname.slice(1)).toLowerCase(),
    };
  }

  return {
    kind: "posix",
    value: path.resolve(fileURLToPath(importMetaUrl)),
  };
}

function normalizeCliArgvEntry(argvEntry, kindHint, cwd = process.cwd()) {
  const resolvedEntry =
    kindHint === "win32" ? path.win32.resolve(normalizeWindowsCwd(cwd), argvEntry) : path.resolve(argvEntry);

  if (kindHint === "win32" || /^[A-Za-z]:[\\/]/.test(resolvedEntry)) {
    return {
      kind: "win32",
      value: path.win32.normalize(resolvedEntry).toLowerCase(),
    };
  }

  return {
    kind: "posix",
    value: resolvedEntry,
  };
}

function normalizeWindowsCwd(cwd) {
  if (/^[A-Za-z]:[\\/]/.test(cwd)) {
    return cwd;
  }

  return cwd.replace(/\//g, "\\");
}

export function executeRelease(plan, overrides = {}) {
  const { fs, exec, inspectDependencies, listTarEntries: listTarEntriesPort } = createProcessPorts(overrides);
  const stdout = overrides.stdout ?? process.stdout;

  if (plan.blockers.length > 0) {
    stdout.write(formatReleasePlan(plan));
    return {
      exitCode: 1,
      publishedTargets: [],
    };
  }

  if (plan.dryRun) {
    stdout.write(formatReleasePlan(plan));
    return {
      exitCode: 0,
      publishedTargets: [],
    };
  }

  prepareDependencies(plan, { exec, fs, inspectDependencies }, stdout);
  ensureNpmCommandEnvironment(fs, plan.repoRoot);
  const releaseBuildEnv = createReleaseBuildEnv(plan);

  const publishRegistries = plan.actions.publish
    ? Object.fromEntries(
        plan.targets.map((target) => [target.id, resolvePublishRegistry(exec, plan.repoRoot, target.packageName)]),
      )
    : {};
  const registrySummary = plan.actions.publish
    ? plan.targets.map((target) => `${target.id}: ${publishRegistries[target.id]}`).join(", ")
    : "publish skipped";
  const whoami = plan.actions.publish
    ? plan.targets.map((target) => `${target.id}: ${readWhoAmI(exec, plan.repoRoot, publishRegistries[target.id])}`).join(", ")
    : "publish skipped";
  printRuntimeHeader(stdout, plan, registrySummary, whoami);

  const publishedTargets = [];
  const mutatedTargets = [];
  const publishAttemptedTargetIds = new Set();

  try {
    for (const target of plan.targets) {
      updateManifestVersion(fs, target.versionSourceAbsolute, target.targetVersion);
      mutatedTargets.push(target);

      stdout.write(`Running build for ${target.id}\n`);
      for (const command of target.buildSteps) {
        runCommand(exec, command, plan.repoRoot, releaseBuildEnv);
      }

      if (plan.parsed.skipVerify) {
        stdout.write(`Skipping verify for ${target.id} (--skip-verify)\n`);
      } else {
        stdout.write(`Running verify for ${target.id}\n`);
        runCommand(exec, target.verifyStep, plan.repoRoot, releaseBuildEnv);
      }

      ensurePreparePublishTarget(fs, target);
      for (const command of target.preparePublishSteps) {
        stdout.write(`Preparing publish artifact for ${target.id}: ${formatCommand(command)}\n`);
        runCommand(exec, command, target.packageRootAbsolute, releaseBuildEnv);
      }

      const readiness = evaluatePublishReadiness(target, {
        fs,
        listTarEntries: listTarEntriesPort,
      });
      stdout.write(formatReadiness(readiness));

      if (!readiness.releaseReady) {
        restoreManifestVersion(fs, target.versionSourceAbsolute, target.currentVersion);
        stdout.write(`release readiness failed for ${target.id}; publish has been blocked\n`);
        if (publishedTargets.length > 0) {
          stdout.write(
            `recovery: ${publishedTargets
              .map((entry) => `${entry.id}@${entry.targetVersion}`)
              .join(", ")} already published; do not republish the same version.\n`,
          );
        }
        return {
          exitCode: 1,
          publishedTargets,
        };
      }

      if (plan.actions.publish) {
        maybeInjectFailure(target, "before-publish");
        const publishCommand = target.publishMode === "tarball"
          ? ["npm", "publish", target.publishArtifactAbsolute, "--tag", target.distTag, "--registry", publishRegistries[target.id]]
          : ["npm", "publish", "--tag", target.distTag, "--registry", publishRegistries[target.id]];
        stdout.write(`Publishing ${target.id}: ${formatCommand(publishCommand)}\n`);
        publishAttemptedTargetIds.add(target.id);
        runCommand(exec, publishCommand, target.publishMode === "tarball" ? plan.repoRoot : target.publishRootAbsolute, releaseBuildEnv);
        publishedTargets.push(target);
        printPublishedFact(stdout, target);
        maybeInjectFailure(target, "after-publish");
      }
    }

    if (plan.actions.commit) {
      const stagedFiles = plan.targets.map((target) => target.versionSourceRelative);
      runCommand(exec, ["git", "add", "--", ...stagedFiles], plan.repoRoot);
      runCommand(exec, ["git", "commit", "-m", toCommitMessage(plan.targets)], plan.repoRoot);

      for (const target of plan.targets) {
        runCommand(exec, ["git", "tag", target.tagName], plan.repoRoot);
      }
    }

    if (plan.actions.push) {
      const branch = getCurrentBranch(exec, plan.repoRoot);
      runCommand(exec, ["git", "push", "origin", branch], plan.repoRoot);
      runCommand(exec, ["git", "push", "origin", ...plan.targets.map((target) => target.tagName)], plan.repoRoot);
    }

    return {
      exitCode: 0,
      publishedTargets,
    };
  } catch (error) {
    for (const target of mutatedTargets) {
      if (publishedTargets.some((entry) => entry.id === target.id)) {
        continue;
      }

      if (publishAttemptedTargetIds.has(target.id)) {
        continue;
      }

      restoreManifestVersion(fs, target.versionSourceAbsolute, target.currentVersion);
    }

    if (publishedTargets.length > 0) {
      stdout.write(
        `recovery: ${publishedTargets
          .map((entry) => `${entry.id}@${entry.targetVersion}`)
          .join(", ")} may already be published; inspect the registry before retrying.\n`,
      );
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const parsed = parseReleaseLocalArgs(argv);
    if (parsed.help) {
      stdout.write(formatHelp());
      return 0;
    }

    const plan = createReleasePlan(parsed, options);
    const result = executeRelease(plan, {
      ...options,
      stdout,
    });
    return result.exitCode;
  } catch (error) {
    stderr.write(`release-local failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  const exitCode = await main();
  process.exit(exitCode);
}
