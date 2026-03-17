#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
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
  createAbortSessionInvokeMessage,
  createChatInvokeMessage,
  createCloseSessionInvokeMessage,
  createCreateSessionInvokeMessage,
  createPermissionReplyInvokeMessage,
  createQuestionReplyInvokeMessage,
  createStatusQueryMessage,
} from "@agent-plugin/test-support/fixtures";
import { MockGatewayServer } from "@agent-plugin/test-support/transport";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const bundleDir = path.join(rootDir, "bundle");
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

function ensureCommand(cmd) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [cmd], { encoding: "utf8" });
  if (result.status !== 0) {
    throw createFailure("LOAD_FAILED", `Missing required command: ${cmd}`, "LOAD_FAILED");
  }
}

function resolveWorkspaceOpenClawCommand() {
  const binName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  const candidate = path.join(rootDir, "node_modules", ".bin", binName);
  if (!existsSync(candidate)) {
    throw createFailure(
      "LOAD_FAILED",
      `Workspace OpenClaw binary not found at ${candidate}. Run pnpm install in the repo root first.`,
      "LOAD_FAILED",
    );
  }
  return candidate;
}

function readCommandVersion(cmd, args = ["--version"]) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw createFailure("LOAD_FAILED", `Failed to determine command version for ${cmd}`, "LOAD_FAILED");
  }
  return result.stdout.trim() || result.stderr.trim() || "unknown";
}

function createFailure(failureCategory, message, failureCode = failureCategory) {
  const error = new Error(message);
  error.failureCategory = failureCategory;
  error.failureCode = failureCode;
  return error;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? rootDir,
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

async function createTempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
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

async function withTimeout(task, ms, label, category, timeoutCode) {
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
  ensureCommand("node");
  openclawCmd = resolveWorkspaceOpenClawCommand();
  const openclawVersion = readCommandVersion(openclawCmd);

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
  await run(openclawCmd, ["--dev", "plugins", "install", bundleDir], {
    cwd: rootDir,
    env: { HOME: tmpHome },
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
      env: { HOME: tmpHome },
      stdio: "ignore",
    },
  );

  gatewayProc = spawnLoggedProcess(
    openclawCmd,
    ["--dev", "gateway", "run", "--allow-unconfigured", "--verbose", "--port", String(openclawPort)],
    gatewayLog,
    {
      cwd: tmpWorkspace,
      env: { HOME: tmpHome },
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
    createCreateSessionInvokeMessage({
      welinkSessionId: "wl-runtime-close",
      payload: { sessionId: "tool-runtime-close" },
    }),
  );
  const closeSessionCreated = await waitForMessage(
    mockGateway,
    (message) => message.type === "session_created" && message.toolSessionId === "tool-runtime-close",
    "close-session session_created",
    cursor,
  );
  assertSessionCreatedShape(closeSessionCreated, {
    welinkSessionId: "wl-runtime-close",
    toolSessionId: "tool-runtime-close",
  });

  cursor = nextCursor(mockGateway);
  mockGateway.send(
    createCloseSessionInvokeMessage({
      welinkSessionId: "wl-runtime-close",
      payload: { toolSessionId: "tool-runtime-close" },
    }),
  );
  const closeSilent = await expectQuiet(mockGateway, cursor);
  if (!closeSilent) {
    throw createFailure("MESSAGE_FLOW_FAILED", "close_session emitted an unexpected immediate response", "MESSAGE_FLOW_FAILED");
  }

  cursor = nextCursor(mockGateway);
  mockGateway.send(
    createCloseSessionInvokeMessage({
      welinkSessionId: "wl-runtime-close",
      payload: { toolSessionId: "tool-runtime-close" },
    }),
  );
  const closeMissing = await waitForMessage(
    mockGateway,
    (message) => message.type === "tool_error" && message.toolSessionId === "tool-runtime-close",
    "close_session missing tool_error",
    cursor,
  );
  assertToolErrorShape(closeMissing, {
    toolSessionId: "tool-runtime-close",
    error: "unknown_tool_session",
    reason: "session_not_found",
    hasCode: false,
  });

  cursor = nextCursor(mockGateway);
  mockGateway.send(
    createCreateSessionInvokeMessage({
      welinkSessionId: "wl-runtime-abort",
      payload: { sessionId: "tool-runtime-abort" },
    }),
  );
  const abortSessionCreated = await waitForMessage(
    mockGateway,
    (message) => message.type === "session_created" && message.toolSessionId === "tool-runtime-abort",
    "abort-session session_created",
    cursor,
  );
  assertSessionCreatedShape(abortSessionCreated, {
    welinkSessionId: "wl-runtime-abort",
    toolSessionId: "tool-runtime-abort",
  });

  cursor = nextCursor(mockGateway);
  mockGateway.send(
    createAbortSessionInvokeMessage({
      welinkSessionId: "wl-runtime-abort",
      payload: { toolSessionId: "tool-runtime-abort" },
    }),
  );
  const abortDone = await waitForMessage(
    mockGateway,
    (message) => message.type === "tool_done" && message.toolSessionId === "tool-runtime-abort",
    "abort_session tool_done",
    cursor,
  );
  assertToolDoneShape(abortDone, {
    welinkSessionId: "wl-runtime-abort",
    toolSessionId: "tool-runtime-abort",
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

  cursor = nextCursor(mockGateway);
  mockGateway.send(
    createQuestionReplyInvokeMessage({
      welinkSessionId: "wl-runtime-question",
      payload: {
        toolSessionId: "tool-runtime-question",
        answer: "ok",
      },
    }),
  );
  const questionError = await waitForMessage(
    mockGateway,
    (message) => message.type === "tool_error" && message.toolSessionId === "tool-runtime-question",
    "question_reply tool_error",
    cursor,
  );
  assertToolErrorShape(questionError, {
    welinkSessionId: "wl-runtime-question",
    toolSessionId: "tool-runtime-question",
    hasCode: false,
  });
  if (!String(questionError.error ?? "").includes("unsupported_in_openclaw_v1:question_reply")) {
    throw createFailure("MESSAGE_FLOW_FAILED", "question_reply did not fail closed with unsupported marker", "MESSAGE_FLOW_FAILED");
  }
  assertNoSuccessMessageOnInvalidInput([permissionError, questionError]);

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
