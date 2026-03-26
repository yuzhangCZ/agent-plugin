#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { MockGatewayServer } from "@agent-plugin/test-support/transport";
import {
  BUNDLE_DIR,
  ROOT_DIR,
  assertVersionSatisfies,
  createFailure,
  createIsolatedHomeEnv,
  createTempDir,
  findAvailablePort,
  readCommandVersion,
  resolveOpenClawCommand,
  run,
  waitForPattern,
  withTimeout,
} from "./openclaw-test-shared.mjs";

const runId = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const logDir = path.join(ROOT_DIR, "logs", `verify-openclaw-load-${runId}`);
const gatewayLog = path.join(logDir, "openclaw-gateway.log");
const summaryLog = path.join(logDir, "summary.log");
const timeoutMs = Number(process.env.MB_LOAD_VERIFY_TIMEOUT_MS ?? "180000");

let tmpHome = "";
let tmpWorkspace = "";
let gatewayProc;
let mockGateway;
const contractChecks = [];

async function appendLog(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, { flag: "a" });
}

async function cleanup() {
  if (gatewayProc && !gatewayProc.killed) {
    gatewayProc.kill();
  }
  if (mockGateway) {
    await mockGateway.stop().catch(() => {});
  }
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  await rm(tmpWorkspace, { recursive: true, force: true }).catch(() => {});
}

async function writeSummary(failureCategory = "NONE", failureCode = "NONE", failureMessage = "") {
  const gatewayLogText = await readFile(gatewayLog, "utf8").catch(() => "");
  const summary = [
    "=== verify-openclaw-load summary ===",
    `failure_category=${failureCategory}`,
    `failure_code=${failureCode}`,
    `failure_message=${failureMessage}`,
    `gateway_log=${gatewayLog}`,
    `tmp_home=${tmpHome}`,
    `tmp_workspace=${tmpWorkspace}`,
    "",
    "--- contract checks ---",
    ...contractChecks,
    "",
    "--- load lines ---",
    ...gatewayLogText.split("\n").filter((line) => line.includes("[message-bridge]") || line.includes("loaded")),
  ].join("\n");

  await mkdir(logDir, { recursive: true });
  await writeFile(summaryLog, summary, "utf8");
}

function getDevConfigPath(homeDir) {
  return path.join(homeDir, ".openclaw-dev", "openclaw.json");
}

async function writeDevConfig(homeDir, config) {
  const configPath = getDevConfigPath(homeDir);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function execCapture(cmd, args, { env, cwd = ROOT_DIR, expectedStatus = 0, label }) {
  const result = spawn(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env,
    shell: false,
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    result.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    result.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    result.on("error", reject);
    result.on("exit", (status) => {
      if (status !== expectedStatus) {
        reject(
          createFailure(
            "LOAD_FAILED",
            `${label} exited with ${status}. stdout=${stdout.trim()} stderr=${stderr.trim()}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, combined: `${stdout}\n${stderr}` });
    });
  });
}

function assertMatches(text, pattern, label) {
  if (!pattern.test(text)) {
    throw createFailure("LOAD_FAILED", `${label} did not match ${pattern}. output=${text.trim()}`);
  }
}

async function verifyConfigStatusContract({ openclawCmd, isolatedEnv, gatewayUrl, baselineConfig }) {
  const pluginInfoResult = await execCapture(
    openclawCmd,
    ["--dev", "plugins", "info", "skill-openclaw-plugin", "--json"],
    {
      env: isolatedEnv,
      label: "plugins info",
    },
  );
  const pluginInfo = JSON.parse(pluginInfoResult.stdout);
  assert.equal(pluginInfo.id, "skill-openclaw-plugin");
  assert.equal(pluginInfo.configSchema, true);
  assert.deepEqual(pluginInfo.channelIds, ["message-bridge"]);
  contractChecks.push("plugins info exposes skill-openclaw-plugin with message-bridge channel metadata");

  const initialStatusResult = await execCapture(openclawCmd, ["--dev", "channels", "status"], {
    env: isolatedEnv,
    label: "channels status (initial)",
  });
  assertMatches(
    initialStatusResult.combined,
    /Message Bridge default: enabled, not configured/,
    "initial channels status",
  );
  contractChecks.push("status reports not configured before setup");

  const useEnvResult = await execCapture(
    openclawCmd,
    ["--dev", "channels", "add", "--channel", "message-bridge", "--use-env"],
    {
      env: isolatedEnv,
      expectedStatus: 1,
      label: "channels add --use-env",
    },
  );
  assertMatches(
    useEnvResult.combined,
    /当前不支持 --use-env/,
    "channels add --use-env validation",
  );
  contractChecks.push("setup rejects --use-env with explicit message");

  const invalidUrlResult = await execCapture(
    openclawCmd,
    [
      "--dev",
      "channels",
      "add",
      "--channel",
      "message-bridge",
      "--url",
      "http://example.com",
      "--token",
      "load-ak",
      "--password",
      "load-sk",
    ],
    {
      env: isolatedEnv,
      expectedStatus: 1,
      label: "channels add invalid url",
    },
  );
  assertMatches(
    invalidUrlResult.combined,
    /gateway\.url 必须使用 ws:\/\/ 或 wss:\/\//,
    "channels add invalid url validation",
  );
  contractChecks.push("setup rejects non-websocket gateway urls");

  await writeDevConfig(tmpHome, {
    ...baselineConfig,
    channels: {
      ...(baselineConfig.channels ?? {}),
      "message-bridge": {
        accounts: {
          default: {
            gateway: {
              url: gatewayUrl,
            },
            auth: {
              ak: "legacy-ak",
              sk: "legacy-sk",
            },
          },
        },
      },
    },
  });
  const legacyConfigResult = await execCapture(
    openclawCmd,
    [
      "--dev",
      "channels",
      "add",
      "--channel",
      "message-bridge",
      "--url",
      gatewayUrl,
      "--token",
      "load-ak",
      "--password",
      "load-sk",
    ],
    {
      env: isolatedEnv,
      expectedStatus: 1,
      label: "channels add with legacy config",
    },
  );
  assertMatches(
    legacyConfigResult.combined,
    /channels\.message-bridge\.accounts 配置.*迁移到 channels\.message-bridge 顶层/s,
    "legacy accounts migration validation",
  );
  contractChecks.push("setup surfaces legacy accounts migration guidance");

  await writeDevConfig(tmpHome, baselineConfig);
  const validSetupResult = await execCapture(
    openclawCmd,
    [
      "--dev",
      "channels",
      "add",
      "--channel",
      "message-bridge",
      "--name",
      "Bridge",
      "--url",
      gatewayUrl,
      "--token",
      "load-ak",
      "--password",
      "load-sk",
    ],
    {
      env: isolatedEnv,
      label: "channels add valid setup",
    },
  );
  assertMatches(
    validSetupResult.combined,
    /Added Message Bridge account "default"\./,
    "successful channels add",
  );
  contractChecks.push("setup writes valid default account config");

  const listResult = await execCapture(openclawCmd, ["--dev", "channels", "list", "--json"], {
    env: isolatedEnv,
    label: "channels list",
  });
  const listedChannels = JSON.parse(listResult.stdout);
  assert.deepEqual(listedChannels.chat?.["message-bridge"], ["default"]);
  contractChecks.push("channels list exposes only the default account id");

  const configuredStatusResult = await execCapture(openclawCmd, ["--dev", "channels", "status"], {
    env: isolatedEnv,
    label: "channels status (configured)",
  });
  assertMatches(
    configuredStatusResult.combined,
    /Message Bridge default \(Bridge\): enabled, configured, token:config/,
    "configured channels status",
  );
  contractChecks.push("status summary reflects configured account name and token source");
}

async function main() {
  const openclawCmd = resolveOpenClawCommand();
  const packageJson = JSON.parse(await readFile(path.join(ROOT_DIR, "package.json"), "utf8"));
  assertVersionSatisfies(readCommandVersion(openclawCmd), packageJson.peerDependencies?.openclaw ?? ">=0.0.0");

  const gatewayPort = await findAvailablePort(Number(process.env.MB_RUNTIME_GATEWAY_PORT ?? "18081"));
  const openclawPort = await findAvailablePort(Number(process.env.MB_RUNTIME_OPENCLAW_PORT ?? "19101"));
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/ws/agent`;

  await mkdir(logDir, { recursive: true });
  tmpHome = await createTempDir("mb-openclaw-load-home-");
  tmpWorkspace = await createTempDir("mb-openclaw-load-workspace-");
  const isolatedEnv = createIsolatedHomeEnv(tmpHome);
  await run(openclawCmd, ["--dev", "plugins", "install", BUNDLE_DIR], {
    cwd: ROOT_DIR,
    env: isolatedEnv,
    stdio: "ignore",
  });
  const baselineConfig = JSON.parse(
    (await readFile(getDevConfigPath(tmpHome), "utf8").catch(() => "{}")) || "{}",
  );
  await verifyConfigStatusContract({
    openclawCmd,
    isolatedEnv,
    gatewayUrl,
    baselineConfig,
  });

  mockGateway = new MockGatewayServer({
    port: gatewayPort,
    onMessage(message, socket) {
      if (message?.type === "register") {
        socket.send(JSON.stringify({ type: "register_ok" }));
      }
    },
  });

  await mockGateway.start();

  gatewayProc = spawn(
    openclawCmd,
    ["--dev", "gateway", "run", "--allow-unconfigured", "--verbose", "--port", String(openclawPort)],
    {
      cwd: tmpWorkspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: isolatedEnv,
      shell: false,
    },
  );

  gatewayProc?.stdout?.on("data", (chunk) => appendLog(gatewayLog, chunk.toString()));
  gatewayProc?.stderr?.on("data", (chunk) => appendLog(gatewayLog, chunk.toString()));

  const connected = await mockGateway.waitForConnection(20000);
  if (!connected) {
    throw createFailure("LOAD_FAILED", "OpenClaw gateway did not connect to mock ai-gateway");
  }

  const registerMessage = await mockGateway.waitForMessage((message) => message.type === "register", 20000, 0);
  if (!registerMessage) {
    throw createFailure("LOAD_FAILED", "Plugin did not send register during host load verification");
  }

  const readyObserved = await waitForPattern(gatewayLog, /\[message-bridge\] gateway\.ready/, 100, 200, (file) => readFile(file, "utf8"));
  const startedObserved = await waitForPattern(
    gatewayLog,
    /\[message-bridge\] runtime\.start\.completed/,
    100,
    200,
    (file) => readFile(file, "utf8"),
  );
  if (!readyObserved || !startedObserved) {
    throw createFailure("LOAD_FAILED", "Plugin did not complete host load and channel startup");
  }

  await writeSummary();
  console.log("[verify-openclaw-load] PASS");
  console.log(`summary=${summaryLog}`);
}

withTimeout(() => main(), timeoutMs, "verify-openclaw-load", "LOAD_FAILED", "LOAD_TIMEOUT")
  .catch(async (error) => {
    const failureCategory =
      error && typeof error === "object" && "failureCategory" in error ? error.failureCategory : "LOAD_FAILED";
    const failureCode =
      error && typeof error === "object" && "failureCode" in error ? error.failureCode : failureCategory;
    const failureMessage = error instanceof Error ? error.message : String(error);
    await writeSummary(failureCategory, failureCode, failureMessage).catch(() => {});
    console.error(`failure_category=${failureCategory}`);
    console.error(`failure_code=${failureCode}`);
    console.error(failureMessage);
    process.exit(1);
  })
  .finally(cleanup);
