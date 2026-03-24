#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseTarEntriesOutput } from "./tar-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "release-local-e2e-"));
const sourceCopyDir = path.join(tempRoot, "workspace");
const consumerDir = path.join(tempRoot, "consumer");
const e2eHomeDir = path.join(tempRoot, "home");
const userConfigPath = path.join(e2eHomeDir, ".npmrc");
const externalRegistryUrl = process.env.RELEASE_E2E_REGISTRY_URL?.trim() || "";
const externalToken = process.env.RELEASE_E2E_NPM_TOKEN?.trim() || "";
const keepTemp = process.env.RELEASE_E2E_KEEP_TMP === "1";
const remotePath = process.env.RELEASE_E2E_REMOTE_PATH?.trim() || path.join(tempRoot, "remote.git");
const verdaccioConfigPath = path.join(tempRoot, "verdaccio.yaml");
const verdaccioStoragePath = path.join(tempRoot, "verdaccio-storage");
const verdaccioLogPath = path.join(tempRoot, "verdaccio.log");

let registryProcess = null;
let registryUrl = "";

const excludedSegmentNames = new Set([".git", ".opencode", "node_modules", ".pnpm-store", ".tmp", "logs"]);
const excludedRelativePaths = new Set([
  "plugins/message-bridge/release",
  "plugins/message-bridge-openclaw/bundle",
  "plugins/message-bridge-openclaw/dist",
]);

function logStep(message) {
  process.stdout.write(`\n[e2e] ${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    input: options.input,
    stdio: options.stdio ?? "pipe",
  });

  if (result.status !== 0) {
    const rendered = `${command} ${args.join(" ")}`;
    const stdout = result.stdout?.trim() ?? "";
    const stderr = result.stderr?.trim() ?? "";
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`${rendered} failed with code ${result.status}${details ? `\n${details}` : ""}`);
  }

  return {
    stderr: result.stderr?.trim() ?? "",
    stdout: result.stdout?.trim() ?? "",
  };
}

function pathShouldBeCopied(sourcePath) {
  const relativePath = path.relative(repoRoot, sourcePath);
  if (!relativePath || relativePath === "") {
    return true;
  }

  const normalized = relativePath.split(path.sep).join("/");
  if (excludedRelativePaths.has(normalized)) {
    return false;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => excludedSegmentNames.has(segment))) {
    return false;
  }

  return true;
}

async function copyWorkspace() {
  await cp(repoRoot, sourceCopyDir, {
    dereference: false,
    filter: (sourcePath) => pathShouldBeCopied(sourcePath),
    recursive: true,
  });
}

function normalizeRegistryUrl(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function registryHostPath(value) {
  const url = new URL(value);
  const hostPath = `${url.host}${url.pathname}`.replace(/\/+$/, "");
  return hostPath;
}

async function writeUserConfig(registry) {
  await mkdir(e2eHomeDir, { recursive: true });
  const lines = [
    "registry=https://registry.npmjs.org/",
    `@wecode:registry=${registry}`,
    "",
  ];
  await writeFile(userConfigPath, lines.join("\n"), "utf8");
}

async function createTempRegistryConfig(port) {
  const config = `storage: ${JSON.stringify(verdaccioStoragePath)}
auth:
  htpasswd:
    file: ${JSON.stringify(path.join(verdaccioStoragePath, "htpasswd"))}
uplinks:
  npmjs:
    url: "https://registry.npmjs.org/"
packages:
  "@wecode/*":
    access: $all
    publish: $all
    unpublish: $all
    proxy: npmjs
  "**":
    access: $all
    publish: $all
    unpublish: $all
    proxy: npmjs
server:
  keepAliveTimeout: 60
logs:
  - { type: stdout, format: pretty, level: http }
`;

  await mkdir(verdaccioStoragePath, { recursive: true });
  await writeFile(verdaccioConfigPath, config, "utf8");

  registryProcess = spawn(
    "pnpm",
    ["dlx", "verdaccio@6", "--config", verdaccioConfigPath, "--listen", `127.0.0.1:${port}`],
    {
      cwd: tempRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  registryProcess.stdout?.on("data", (chunk) => appendLog(chunk.toString()));
  registryProcess.stderr?.on("data", (chunk) => appendLog(chunk.toString()));
  registryProcess.on("exit", (code) => {
    if (code !== 0) {
      appendLog(`verdaccio exited with code ${code}\n`);
    }
  });
}

async function appendLog(text) {
  await writeFile(verdaccioLogPath, text, { encoding: "utf8", flag: "a" });
}

async function waitForRegistry(registry, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(new URL("-/ping", registry));
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const logOutput = existsSync(verdaccioLogPath) ? await readFile(verdaccioLogPath, "utf8") : "";
  throw new Error(`timed out waiting for fake registry ${registry}\n${logOutput}`);
}

async function findAvailablePort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("failed to resolve free port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function loginRegistry(registry) {
  if (externalToken) {
    await writeFile(
      userConfigPath,
      `${await readFile(userConfigPath, "utf8")}//${registryHostPath(registry)}/:_authToken=${externalToken}\n`,
      "utf8",
    );
    return;
  }

  const username = "release-bot";
  const password = "release-pass";
  const email = "release@example.com";
  const basicAuth = Buffer.from(`${username}:${password}`).toString("base64");
  const response = await fetch(new URL(`-/user/org.couchdb.user:${encodeURIComponent(username)}`, registry), {
    method: "PUT",
    headers: {
      authorization: `Basic ${basicAuth}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      _id: `org.couchdb.user:${username}`,
      date: new Date().toISOString(),
      email,
      name: username,
      password,
      roles: [],
      type: "user",
    }),
  });

  if (!response.ok) {
    throw new Error(`fake registry login failed: ${response.status} ${response.statusText}\n${await response.text()}`);
  }

  const payload = await response.json();
  const token = typeof payload?.token === "string" ? payload.token : "";
  if (!token) {
    throw new Error(`failed to obtain auth token for fake registry ${registry}`);
  }

  await writeFile(
    userConfigPath,
    `${await readFile(userConfigPath, "utf8")}//${registryHostPath(registry)}/:_authToken=${token}\n`,
    "utf8",
  );
}

async function initWorkspaceGit() {
  run("git", ["init", "-b", "main"], { cwd: sourceCopyDir });
  run("git", ["config", "user.name", "Release E2E"], { cwd: sourceCopyDir });
  run("git", ["config", "user.email", "release-e2e@example.com"], { cwd: sourceCopyDir });
  run("git", ["add", "."], { cwd: sourceCopyDir });
  run("git", ["commit", "-m", "baseline"], { cwd: sourceCopyDir });

  if (!existsSync(remotePath)) {
    await mkdir(path.dirname(remotePath), { recursive: true });
    run("git", ["init", "--bare", remotePath], { cwd: sourceCopyDir });
  }

  run("git", ["remote", "add", "origin", remotePath], { cwd: sourceCopyDir });
  run("git", ["push", "-u", "origin", "main"], { cwd: sourceCopyDir });
}

function releaseEnv(extra = {}) {
  return {
    ...process.env,
    HOME: e2eHomeDir,
    USERPROFILE: e2eHomeDir,
    XDG_CONFIG_HOME: path.join(e2eHomeDir, ".config"),
    ...extra,
  };
}

function runRelease(args, extraEnv = {}) {
  return run("pnpm", ["run", "release:local", "--", ...args], {
    cwd: sourceCopyDir,
    env: releaseEnv(extraEnv),
  });
}

function tryRunRelease(args, extraEnv = {}) {
  const result = spawnSync("pnpm", ["run", "release:local", "--", ...args], {
    cwd: sourceCopyDir,
    encoding: "utf8",
    env: releaseEnv(extraEnv),
    stdio: "pipe",
  });

  return {
    code: result.status ?? 1,
    stderr: result.stderr?.trim() ?? "",
    stdout: result.stdout?.trim() ?? "",
  };
}

function npmView(spec, query) {
  return run("npm", ["view", spec, query, "--registry", registryUrl], {
    cwd: sourceCopyDir,
    env: releaseEnv(),
  }).stdout;
}

async function packFromRegistry(spec, destinationDir) {
  await rm(destinationDir, { recursive: true, force: true });
  await mkdir(destinationDir, { recursive: true });

  run("npm", ["pack", spec, "--pack-destination", destinationDir, "--registry", registryUrl], {
    cwd: sourceCopyDir,
    env: releaseEnv(),
  });

  const tgzName = (await readdir(destinationDir)).find((entry) => entry.endsWith(".tgz"));
  if (!tgzName) {
    throw new Error(`no tgz produced for ${spec}`);
  }

  return path.join(destinationDir, tgzName);
}

function tarEntries(tgzPath) {
  return parseTarEntriesOutput(run("tar", ["-tzf", tgzPath]).stdout);
}

async function readPackedManifest(tgzPath) {
  const extractDir = path.join(tempRoot, `extract-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(extractDir, { recursive: true });
  run("tar", ["-xzf", tgzPath, "-C", extractDir]);
  const manifestPath = path.join(extractDir, "package", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  await rm(extractDir, { recursive: true, force: true });
  return manifest;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertTagExists(tagName) {
  run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`], { cwd: sourceCopyDir });
}

function assertRemoteRefExists(refName) {
  run("git", ["--git-dir", remotePath, "rev-parse", "--verify", "--quiet", refName]);
}

async function installDependencies() {
  run("pnpm", ["install", "--frozen-lockfile"], { cwd: sourceCopyDir, stdio: "inherit" });
}

async function recreateIsolatedWorkspace({ resetRemote = false } = {}) {
  await rm(sourceCopyDir, { recursive: true, force: true });
  if (resetRemote) {
    await rm(remotePath, { recursive: true, force: true });
  }
  await copyWorkspace();
  await initWorkspaceGit();
  await installDependencies();
}

async function verifyBridgeStable() {
  logStep("bridge stable release");
  runRelease(["--target", "message-bridge", "--version", "1.0.1"]);
  assert(npmView("@wecode/skill-opencode-plugin@1.0.1", "version") === "1.0.1", "bridge stable version not found");
  assertTagExists("release/message-bridge/v1.0.1");
  const tgz = await packFromRegistry("@wecode/skill-opencode-plugin@1.0.1", path.join(consumerDir, "bridge-stable"));
  const entries = tarEntries(tgz);
  assert(entries.includes("package/release/message-bridge.plugin.js"), "bridge tarball missing runtime entry");
  const manifest = await readPackedManifest(tgz);
  assert(manifest.main === "release/message-bridge.plugin.js", "bridge tarball main field changed");
}

async function verifyOpenClawStable() {
  logStep("openclaw stable release");
  runRelease(["--target", "message-bridge-openclaw", "--version", "0.2.0"]);
  assert(
    npmView("@wecode/skill-openclaw-plugin@0.2.0", "version") === "0.2.0",
    "openclaw stable version not found",
  );
  assertTagExists("release/message-bridge-openclaw/v0.2.0");
  const tgz = await packFromRegistry("@wecode/skill-openclaw-plugin@0.2.0", path.join(consumerDir, "openclaw-stable"));
  const entries = tarEntries(tgz);
  for (const required of [
    "package/index.js",
    "package/package.json",
    "package/openclaw.plugin.json",
    "package/README.md",
  ]) {
    assert(entries.includes(required), `openclaw tarball missing ${required}`);
  }
  assert(!entries.some((entry) => entry.startsWith("package/docs/")), "openclaw tarball leaked docs/");
  assert(!entries.some((entry) => entry.startsWith("package/dist/")), "openclaw tarball leaked dist/");
  assert(!entries.some((entry) => entry.endsWith(".map")), "openclaw tarball leaked sourcemap");
}

async function verifyPrerelease() {
  logStep("bridge prerelease");
  runRelease(["--target", "message-bridge", "--bump", "prerelease", "--preid", "beta"]);
  const betaTag = npmView("@wecode/skill-opencode-plugin", "dist-tags.beta");
  const latestTag = npmView("@wecode/skill-opencode-plugin", "dist-tags.latest");
  assert(betaTag === "1.0.2-beta.0", "bridge prerelease dist-tag beta not updated");
  assert(latestTag === "1.0.1", "bridge prerelease should not overwrite latest");
}

async function verifyDualSuccess() {
  logStep("dual success release");
  runRelease(["--target", "dual", "--bridge-version", "1.1.0", "--openclaw-version", "0.3.0"]);
  assert(npmView("@wecode/skill-opencode-plugin@1.1.0", "version") === "1.1.0", "dual bridge version missing");
  assert(npmView("@wecode/skill-openclaw-plugin@0.3.0", "version") === "0.3.0", "dual openclaw version missing");
}

async function verifyDualFailure() {
  logStep("dual failure injection");
  const result = tryRunRelease(
    ["--target", "dual", "--bridge-version", "1.1.1", "--openclaw-version", "0.3.1"],
    {
      RELEASE_LOCAL_FAIL_STAGE: "before-publish",
      RELEASE_LOCAL_FAIL_TARGET: "message-bridge-openclaw",
    },
  );

  assert(result.code !== 0, "dual failure injection should fail");
  assert(
    npmView("@wecode/skill-opencode-plugin@1.1.1", "version") === "1.1.1",
    "bridge version should already be published in dual failure scenario",
  );

  const missingOpenClaw = spawnSync(
    "npm",
    ["view", "@wecode/skill-openclaw-plugin@0.3.1", "version", "--registry", registryUrl],
    {
      cwd: sourceCopyDir,
      encoding: "utf8",
      env: releaseEnv(),
      stdio: "pipe",
    },
  );
  assert(missingOpenClaw.status !== 0, "openclaw second publish should not succeed in injected failure scenario");
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  assert(/may already be published|already published/i.test(combinedOutput), "dual failure recovery hint missing");
}

async function verifyPush() {
  logStep("push to isolated bare remote");
  await recreateIsolatedWorkspace({ resetRemote: true });
  runRelease(["--target", "message-bridge-openclaw", "--version", "0.4.0", "--push"]);
  assertRemoteRefExists("refs/heads/main");
  assertRemoteRefExists("refs/tags/release/message-bridge-openclaw/v0.4.0");
}

async function cleanup() {
  if (registryProcess && !registryProcess.killed) {
    registryProcess.kill("SIGTERM");
  }
  if (!keepTemp) {
    await rm(tempRoot, { force: true, recursive: true }).catch(() => {});
  }
}

async function setupRegistry() {
  if (externalRegistryUrl) {
    registryUrl = normalizeRegistryUrl(externalRegistryUrl);
    await writeUserConfig(registryUrl);
    await loginRegistry(registryUrl);
    return;
  }

  const port = await findAvailablePort();
  registryUrl = `http://127.0.0.1:${port}/`;
  await createTempRegistryConfig(port);
  await waitForRegistry(registryUrl);
  await writeUserConfig(registryUrl);
  await loginRegistry(registryUrl);
}

async function main() {
  try {
    logStep("copy workspace to isolated temp directory");
    await copyWorkspace();

    logStep("initialize isolated git repository and bare remote");
    await initWorkspaceGit();

    logStep("install dependencies in isolated workspace");
    await installDependencies();

    logStep("start fake registry");
    await setupRegistry();

    await verifyBridgeStable();
    await verifyOpenClawStable();
    await verifyPrerelease();
    await verifyDualSuccess();
    await verifyDualFailure();
    await verifyPush();

    process.stdout.write(`\n[e2e] PASS\n[e2e] tempRoot=${tempRoot}\n[e2e] registry=${registryUrl}\n`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error("[e2e] FAIL");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(`[e2e] tempRoot=${tempRoot}`);
  console.error(`[e2e] registry=${registryUrl || "not-started"}`);
  process.exit(1);
});
