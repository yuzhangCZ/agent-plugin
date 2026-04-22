import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import {
  assertInvalidInvokeToolErrorContract,
  createInvalidInvokeInboundFrame,
} from "@agent-plugin/test-support/assertions";
import { normalizeDownstreamMessage } from "../../src/protocol/downstream.ts";

test("normalizes chat invoke message", () => {
  const result = normalizeDownstreamMessage({
    type: "invoke",
    welinkSessionId: "wl_1",
    action: "chat",
    payload: {
      toolSessionId: "tool_1",
      text: "hello",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.action, "chat");
  assert.equal(result.value.payload.toolSessionId, "tool_1");
});

test("rejects unsupported message", () => {
  const result = normalizeDownstreamMessage({
    type: "unknown",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsupported_message");
});

test("create_session requires welinkSessionId", () => {
  const result = normalizeDownstreamMessage({
    type: "invoke",
    action: "create_session",
    payload: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "missing_required_field");
  assert.match(result.error.message, /welinkSessionId/);
});

test("permission_reply invalid payload is rejected with action context", () => {
  const result = normalizeDownstreamMessage({
    type: "invoke",
    action: "permission_reply",
    payload: {
      toolSessionId: "tool_1",
      response: "once",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "missing_required_field");
  assert.equal(result.error.action, "permission_reply");
});

test("permission_reply rejects unsupported response values", () => {
  const result = normalizeDownstreamMessage({
    type: "invoke",
    action: "permission_reply",
    payload: {
      toolSessionId: "tool_1",
      permissionId: "perm_1",
      response: "deny",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_payload");
  assert.equal(result.error.action, "permission_reply");
});

test("question_reply invalid payload is rejected with action context", () => {
  const result = normalizeDownstreamMessage({
    type: "invoke",
    action: "question_reply",
    payload: {
      toolSessionId: "tool_2",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "missing_required_field");
  assert.equal(result.error.action, "question_reply");
});

test("question_reply rejects blank toolCallId when provided", () => {
  const result = normalizeDownstreamMessage({
    type: "invoke",
    action: "question_reply",
    payload: {
      toolSessionId: "tool_2",
      answer: "ok",
      toolCallId: "   ",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_payload");
  assert.equal(result.error.action, "question_reply");
});

test("logs downstream.normalization_failed with stage and field", () => {
  const warns = [];
  const result = normalizeDownstreamMessage(
    {
      type: "invoke",
      welinkSessionId: "wl_log_1",
      action: "chat",
      payload: {
        toolSessionId: "tool_log_1",
      },
    },
    {
      info() {},
      warn(message, meta) {
        warns.push({ message, meta });
      },
      error() {},
    },
  );

  assert.equal(result.ok, false);
  assert.equal(warns.length, 1);
  assert.equal(warns[0].message, "downstream.normalization_failed");
  assert.equal(warns[0].meta.stage, "payload");
  assert.equal(warns[0].meta.field, "payload.text");
  assert.equal(warns[0].meta.errorCode, "missing_required_field");
  assert.equal(warns[0].meta.messageType, "invoke");
  assert.equal(warns[0].meta.action, "chat");
  assert.equal(warns[0].meta.welinkSessionId, "wl_log_1");
});

class FakeGatewayClient {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.connected = true;
    this.state = "READY";
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  async connect() {
    this.connected = true;
  }

  disconnect() {
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }

  getState() {
    return this.state;
  }

  getStatus() {
    return {
      isReady: () => this.state === "READY",
    };
  }

  setState(state) {
    this.state = state;
  }

  send(message) {
    this.sent.push(message);
  }

  emit(event, payload) {
    const listeners = this.listeners.get(event) ?? [];
    for (const listener of listeners) {
      listener(payload);
    }
  }
}

let bridgeModulePromise = null;

async function loadOpenClawGatewayBridgeModule() {
  if (!bridgeModulePromise) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "openclaw/plugin-sdk/channel-runtime") {
          return {
            url: "data:text/javascript,export const createReplyPrefixOptions = () => ({ onModelSelected: undefined });",
            shortCircuit: true,
          };
        }
        if (specifier === "openclaw/plugin-sdk/reply-payload") {
          return {
            url: "data:text/javascript,export const normalizeOutboundReplyPayload = (value) => value;",
            shortCircuit: true,
          };
        }
        return nextResolve(specifier, context);
      },
    });
    bridgeModulePromise = import("../../src/OpenClawGatewayBridge.ts");
  }
  return bridgeModulePromise;
}

async function createOpenClawGatewayBridgeForTest() {
  const { OpenClawGatewayBridge } = await loadOpenClawGatewayBridgeModule();
  const connection = new FakeGatewayClient();
  const logs = { debug: [], info: [], warn: [], error: [] };
  const statuses = [];
  const logger = {
    debug(message, meta) {
      logs.debug.push({ message, meta });
    },
    info(message, meta) {
      logs.info.push({ message, meta });
    },
    warn(message, meta) {
      logs.warn.push({ message, meta });
    },
    error(message, meta) {
      logs.error.push({ message, meta });
    },
  };
  const bridge = new OpenClawGatewayBridge({
    account: {
      accountId: "acct_test",
      enabled: true,
      debug: false,
      gateway: {
        url: "ws://localhost:8081/ws/agent",
      },
      auth: {
        ak: "ak-test",
        sk: "sk-test",
      },
      agentIdPrefix: "tool",
      runTimeoutMs: 1000,
    },
    config: {},
    logger,
    runtime: {},
    setStatus(status) {
      statuses.push({ ...status });
    },
    connectionFactory: () => connection,
  });
  return { bridge, connection, logs, statuses };
}

test("openclaw bridge source delegates runtime uplink generation to bridge-runtime-sdk", async () => {
  const source = await readFile(new URL("../../src/OpenClawGatewayBridge.ts", import.meta.url), "utf8");

  assert.match(source, /createBridgeRuntime/);
  assert.doesNotMatch(source, /sendValidatedUpstreamMessage/);
  assert.doesNotMatch(source, /sendToolDone/);
  assert.doesNotMatch(source, /sendToolError/);
  assert.doesNotMatch(source, /onGatewayConnectionCreated/);
});

test("openclaw bridge replies tool_error for routable invalid invoke inbound frames", async () => {
  const { bridge, connection } = await createOpenClawGatewayBridgeForTest();

  await bridge.start();
  connection.emit("inbound", createInvalidInvokeInboundFrame());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connection.sent.length, 1);
  assertInvalidInvokeToolErrorContract(connection.sent[0], {
    code: "missing_required_field",
    welinkSessionId: "wl-invalid-1",
    toolSessionId: "tool-invalid-1",
  });
});

test("openclaw bridge only logs unroutable invalid invoke inbound frames", async () => {
  const { connection, logs } = await createOpenClawGatewayBridgeForTest();

  connection.emit(
    "inbound",
    createInvalidInvokeInboundFrame({
      welinkSessionId: undefined,
      toolSessionId: undefined,
      violation: {
        violation: {
          stage: "payload",
          code: "missing_required_field",
          field: "payload.text",
          message: "payload.text is required",
          messageType: "invoke",
          action: "chat",
        },
      },
      rawPreview: {
        type: "invoke",
        action: "chat",
        payload: {},
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(connection.sent, []);
  assert.equal(logs.warn.length, 0);
});

test("openclaw bridge skips invalid invoke tool_error before READY", async () => {
  const { connection, logs } = await createOpenClawGatewayBridgeForTest();
  connection.setState("CONNECTED");

  connection.emit("inbound", createInvalidInvokeInboundFrame());
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(connection.sent, []);
  assert.equal(logs.warn.length, 0);
});

test("openclaw bridge ignores error events for invalid-invoke tool_error bridging", async () => {
  const { connection, logs } = await createOpenClawGatewayBridgeForTest();

  connection.emit("error", new Error("gateway protocol error"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(connection.sent, []);
  assert.equal(logs.warn.length, 0);
});

test("openclaw bridge replies tool_error when only welinkSessionId is routable", async () => {
  const { bridge, connection } = await createOpenClawGatewayBridgeForTest();

  await bridge.start();
  connection.emit(
    "inbound",
    createInvalidInvokeInboundFrame({
      toolSessionId: undefined,
      violation: {
        violation: {
          stage: "payload",
          code: "missing_required_field",
          field: "payload.text",
          message: "payload.text is required",
          messageType: "invoke",
          action: "chat",
          welinkSessionId: "wl-invalid-1",
        },
      },
      rawPreview: {
        type: "invoke",
        messageId: "gw-invalid-1",
        action: "chat",
        welinkSessionId: "wl-invalid-1",
        payload: {},
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connection.sent.length, 1);
  assertInvalidInvokeToolErrorContract(connection.sent[0], {
    code: "missing_required_field",
    welinkSessionId: "wl-invalid-1",
    toolSessionId: undefined,
  });
});

test("openclaw bridge replies tool_error when only toolSessionId is routable", async () => {
  const { bridge, connection } = await createOpenClawGatewayBridgeForTest();

  await bridge.start();
  connection.emit(
    "inbound",
    createInvalidInvokeInboundFrame({
      welinkSessionId: undefined,
      violation: {
        violation: {
          stage: "payload",
          code: "missing_required_field",
          field: "payload.text",
          message: "payload.text is required",
          messageType: "invoke",
          action: "chat",
          toolSessionId: "tool-invalid-1",
        },
      },
      rawPreview: {
        type: "invoke",
        messageId: "gw-invalid-1",
        action: "chat",
        payload: {
          toolSessionId: "tool-invalid-1",
        },
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connection.sent.length, 1);
  assertInvalidInvokeToolErrorContract(connection.sent[0], {
    code: "missing_required_field",
    welinkSessionId: undefined,
    toolSessionId: "tool-invalid-1",
  });
});

test("openclaw bridge start wires invalid invoke inbound frames to tool_error", async () => {
  const { bridge, connection } = await createOpenClawGatewayBridgeForTest();

  await bridge.start();
  connection.emit("inbound", createInvalidInvokeInboundFrame());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connection.sent.length, 1);
  assertInvalidInvokeToolErrorContract(connection.sent[0], {
    code: "missing_required_field",
    welinkSessionId: "wl-invalid-1",
    toolSessionId: "tool-invalid-1",
  });
});

test("openclaw bridge preserves shared runtime failed state in published status", async () => {
  const { bridge, connection, statuses } = await createOpenClawGatewayBridgeForTest();

  await bridge.start();
  connection.emit("error", {
    code: "GATEWAY_REGISTER_REJECTED",
    category: "auth",
    retryable: false,
    message: "rejected",
  });
  await new Promise((resolve) => setImmediate(resolve));

  const latestStatus = statuses.at(-1);
  assert.equal(latestStatus.runtimePhase, "failed");
  assert.equal(latestStatus.connected, false);
  assert.equal(latestStatus.lastError, "rejected");
});

test("openclaw bridge publishes stopping before settling to idle", async () => {
  const { bridge, statuses } = await createOpenClawGatewayBridgeForTest();

  await bridge.start();
  await bridge.stop();

  assert.equal(
    statuses.some((status) => status.runtimePhase === "stopping"),
    true,
  );
  assert.equal(statuses.at(-1)?.runtimePhase, "idle");
});
