#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertNoSuccessMessageOnInvalidInput,
  assertSessionCreatedShape,
  assertStatusResponseShape,
  assertToolDoneShape,
  assertToolErrorShape,
} from "@agent-plugin/test-support/assertions";
import {
  createChatInvokeMessage,
  createPermissionReplyInvokeMessage,
  createStatusQueryMessage,
} from "@agent-plugin/test-support/fixtures";
import { MockGatewayServer } from "@agent-plugin/test-support/transport";
import {
  BUNDLE_DIR,
  assertVersionSatisfies,
  createFailure,
  createIsolatedHomeEnv,
  createTempDir,
  readCommandVersion,
  resolveOpenClawCommand,
  run,
  withTimeout,
} from "./openclaw-test-shared.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const runId = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const logDir = path.join(rootDir, "logs", `runtime-smoke-${runId}`);
const gatewayLog = path.join(logDir, "openclaw-gateway.log");
const summaryLog = path.join(logDir, "summary.log");
const summaryJson = path.join(logDir, "summary.json");
const timeoutMs = Number(process.env.MB_RUNTIME_SMOKE_TIMEOUT_MS ?? "180000");

let tmpHome = "";
let tmpWorkspace = "";
let gatewayProc;
let mockGateway;
let openclawCmd = "";

function spawnLoggedProcess(cmd, args, logfile, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: false,
  });
  child.stdout?.on("data", (chunk) => appendFileCompat(logfile, chunk.toString()));
  child.stderr?.on("data", (chunk) => appendFileCompat(logfile, chunk.toString()));
  return child;
}

async function appendFileCompat(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, { flag: "a" });
}

async function waitForPattern(file, pattern, maxTries, intervalMs = 200) {
  for (let tries = 0; tries < maxTries; tries += 1) {
    try {
      const text = await readFile(file, "utf8");
      if (pattern.test(text)) {
        return true;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function findAvailablePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => {
      if (port === 0) {
        reject(createFailure("LOAD_FAILED", "Unable to find an available port", "LOAD_FAILED"));
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

async function writeSummary({
  failureCategory = "NONE",
  failureCode = "NONE",
  failureMessage = "",
  gatewayPort = null,
  openclawPort = null,
  chatResult = null,
  openclawVersion = null,
} = {}) {
  const gatewayLogText = await readFile(gatewayLog, "utf8").catch(() => "");
  const summary = [
    "=== runtime-smoke summary ===",
    `failure_category=${failureCategory}`,
    `failure_code=${failureCode}`,
    `failure_message=${failureMessage}`,
    `gateway_log=${gatewayLog}`,
    `summary_json=${summaryJson}`,
    `tmp_home=${tmpHome}`,
    `tmp_workspace=${tmpWorkspace}`,
    `gateway_port=${gatewayPort ?? ""}`,
    `openclaw_port=${openclawPort ?? ""}`,
    `openclaw_cmd=${openclawCmd}`,
    `openclaw_version=${openclawVersion ?? ""}`,
    `chat_result=${chatResult ?? ""}`,
    "",
    "--- openclaw load lines ---",
    ...gatewayLogText
      .split("\n")
      .filter((line) => line.includes("[message-bridge]") || line.includes("loaded without install/load-path provenance")),
  ].join("\n");
  await mkdir(logDir, { recursive: true });
  await writeFile(summaryLog, summary, "utf8");
  await writeFile(
    summaryJson,
    `${JSON.stringify(
      {
        failure_category: failureCategory,
        failure_code: failureCode,
        failure_message: failureMessage,
        gateway_log: gatewayLog,
        summary_log: summaryLog,
        tmp_home: tmpHome,
        tmp_workspace: tmpWorkspace,
        gateway_port: gatewayPort,
        openclaw_port: openclawPort,
        openclaw_cmd: openclawCmd,
        openclaw_version: openclawVersion,
        chat_result: chatResult,
        generated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function waitForMessage(server, predicate, label, fromIndex, timeout = 15000) {
  const message = await server.waitForMessage(predicate, timeout, fromIndex);
  if (!message) {
    throw createFailure("MESSAGE_FLOW_FAILED", `${label} not observed from gateway`, "MESSAGE_FLOW_FAILED");
  }
  return message;
}

function nextCursor(server) {
  return server.receivedMessages.length;
}

async function expectQuiet(server, cursor, quietMs = 750) {
  await new Promise((resolve) => setTimeout(resolve, quietMs));
  return server.receivedMessages.length === cursor;
}

async function main() {
  openclawCmd = resolveOpenClawCommand();
  const openclawVersion = readCommandVersion(openclawCmd);
  const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  assertVersionSatisfies(openclawVersion, packageJson.peerDependencies?.openclaw ?? ">=0.0.0");

  const gatewayPort = await findAvailablePort(Number(process.env.MB_RUNTIME_GATEWAY_PORT ?? "18081"));
  const openclawPort = await findAvailablePort(Number(process.env.MB_RUNTIME_OPENCLAW_PORT ?? "19101"));
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/ws/agent`;

  await mkdir(logDir, { recursive: true });
  tmpHome = await createTempDir("mb-openclaw-runtime-home-");
  tmpWorkspace = await createTempDir("mb-openclaw-runtime-workspace-");

  mockGateway = new MockGatewayServer({
    port: gatewayPort,
    onMessage(message, socket) {
      if (message?.type === "register") {
        socket.send(JSON.stringify({ type: "register_ok" }));
      }
    },
  });

  await mockGateway.start();
  const isolatedEnv = createIsolatedHomeEnv(tmpHome);
  await run(openclawCmd, ["--dev", "plugins", "install", BUNDLE_DIR], {
    cwd: rootDir,
    env: isolatedEnv,
    stdio: "ignore",
  });
  await run(
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
      "runtime-ak",
      "--password",
      "runtime-sk",
    ],
    {
      cwd: rootDir,
      env: isolatedEnv,
      stdio: "ignore",
    },
  );

  gatewayProc = spawnLoggedProcess(
    openclawCmd,
    ["--dev", "gateway", "run", "--allow-unconfigured", "--verbose", "--port", String(openclawPort)],
    gatewayLog,
    {
      cwd: tmpWorkspace,
      env: isolatedEnv,
    },
  );

  const connected = await mockGateway.waitForConnection(20000);
  if (!connected) {
    throw createFailure("LOAD_FAILED", "OpenClaw gateway did not connect to mock ai-gateway", "LOAD_FAILED");
  }
  await waitForMessage(mockGateway, (message) => message.type === "register", "register", 0, 20000);
  if (!(await waitForPattern(gatewayLog, /\[message-bridge\] gateway\.ready/, 100))) {
    throw createFailure("REGISTER_FAILED", "Plugin did not reach gateway.ready", "REGISTER_FAILED");
  }
  if (!(await waitForPattern(gatewayLog, /\[message-bridge\] runtime\.start\.completed/, 100))) {
    throw createFailure("INIT_FAILED", "Plugin did not complete runtime.start", "INIT_FAILED");
  }

  let cursor = nextCursor(mockGateway);
  mockGateway.send(createStatusQueryMessage());
  const statusResponse = await waitForMessage(
    mockGateway,
    (message) => message.type === "status_response",
    "status_response",
    cursor,
  );
  assertStatusResponseShape(statusResponse, {
    opencodeOnline: true,
    envelopeFree: true,
  });

  cursor = nextCursor(mockGateway);
  mockGateway.send(
    createPermissionReplyInvokeMessage({
      welinkSessionId: "wl-runtime-permission",
      payload: {
        toolSessionId: "tool-runtime-permission",
        permissionId: "perm-runtime-1",
        response: "once",
      },
    }),
  );
  const permissionError = await waitForMessage(
    mockGateway,
    (message) => message.type === "tool_error" && message.toolSessionId === "tool-runtime-permission",
    "permission_reply tool_error",
    cursor,
  );
  assertToolErrorShape(permissionError, {
    welinkSessionId: "wl-runtime-permission",
    toolSessionId: "tool-runtime-permission",
    hasCode: false,
  });
  if (!String(permissionError.error ?? "").includes("unsupported_in_openclaw_v1:permission_reply")) {
    throw createFailure("MESSAGE_FLOW_FAILED", "permission_reply did not fail closed with unsupported marker", "MESSAGE_FLOW_FAILED");
  }
  assertNoSuccessMessageOnInvalidInput([permissionError]);

  cursor = nextCursor(mockGateway);
  mockGateway.send(
    createChatInvokeMessage({
      welinkSessionId: "wl-runtime-chat",
      payload: {
        toolSessionId: "tool-runtime-chat",
        text: "runtime smoke ping",
      },
    }),
  );
  const chatTerminal = await waitForMessage(
    mockGateway,
    (message) =>
      ["tool_done", "tool_error"].includes(message.type) && message.toolSessionId === "tool-runtime-chat",
    "chat terminal response",
    cursor,
    30000,
  );
  let chatResult = chatTerminal.type;
  if (chatTerminal.type === "tool_done") {
    assertToolDoneShape(chatTerminal, {
      welinkSessionId: "wl-runtime-chat",
      toolSessionId: "tool-runtime-chat",
    });
  } else {
    assertToolErrorShape(chatTerminal, {
      welinkSessionId: "wl-runtime-chat",
      toolSessionId: "tool-runtime-chat",
      hasCode: false,
    });
  }

  await writeSummary({
    gatewayPort,
    openclawPort,
    chatResult,
    openclawVersion,
  });

  console.log("runtime-smoke passed");
  console.log(`summary=${summaryLog}`);
  console.log(`summary_json=${summaryJson}`);
  console.log(`gateway_log=${gatewayLog}`);
}

withTimeout(() => main(), timeoutMs, "runtime-smoke", "TIMEOUT", "TIMEOUT")
  .catch(async (error) => {
    const failureCategory =
      error && typeof error === "object" && "failureCategory" in error ? error.failureCategory : "MESSAGE_FLOW_FAILED";
    const failureCode =
      error && typeof error === "object" && "failureCode" in error ? error.failureCode : failureCategory;
    const failureMessage = error instanceof Error ? error.message : String(error);
    await writeSummary({
      failureCategory,
      failureCode,
      failureMessage,
    }).catch(() => {});
    console.error(`failure_category=${failureCategory}`);
    console.error(`failure_code=${failureCode}`);
    console.error(failureMessage);
    process.exit(1);
  })
  .finally(cleanup);
