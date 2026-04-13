import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
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
        if (specifier === "openclaw/plugin-sdk") {
          return {
            url: "data:text/javascript,export const createReplyPrefixOptions = () => ({ onModelSelected: undefined }); export const normalizeOutboundReplyPayload = (value) => value;",
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
        heartbeatIntervalMs: 30000,
        reconnect: {
          baseMs: 1,
          maxMs: 4,
          exponential: false,
        },
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
    setStatus() {},
    connectionFactory: () => connection,
  });
  const originalHandleCreateSession = bridge.handleCreateSession;
  bridge.lastCompatInput = null;
  bridge.handleCreateSession = async function patchedHandleCreateSession(message, context) {
    bridge.lastCompatInput = message;
    return originalHandleCreateSession.call(this, message, context);
  };
  return { bridge, connection, logs };
}

test("openclaw bridge applies legacy compat after shared client emits typed facade message", async () => {
  const { bridge, connection } = await createOpenClawGatewayBridgeForTest();

  connection.emit("message", {
    type: "invoke",
    welinkSessionId: "wl_legacy",
    action: "create_session",
    payload: {},
    rawPayload: {
      sessionId: "session-123",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bridge.lastCompatInput.type, "invoke");
  assert.equal(bridge.lastCompatInput.payload.sessionId, "session-123");
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].type, "session_created");
  assert.equal(connection.sent[0].session.sessionId, "session-123");
});
