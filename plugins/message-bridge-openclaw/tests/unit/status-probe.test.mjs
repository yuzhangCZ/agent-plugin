import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

import { buildMessageBridgeResourceKey } from "../../src/gateway-host.ts";
import {
  cancelProbeForRuntimeStart,
  getRuntimeSnapshot,
  updateRuntimeSnapshot,
  __resetConnectionCoordinatorForTests,
} from "../../src/runtime/ConnectionCoordinator.ts";

let statusModulePromise = null;

async function loadStatusModule() {
  if (!statusModulePromise) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "openclaw/plugin-sdk") {
          return {
            url: "data:text/javascript,export const buildBaseAccountStatusSnapshot = (input) => ({ ...input.account, ...input.runtime, probe: input.probe ?? null }); export const buildProbeChannelStatusSummary = () => ({}); export const createDefaultChannelRuntimeState = (accountId, state) => ({ accountId, running: false, ...state }); export const deleteAccountFromConfigSection = () => {}; export const setAccountEnabledInConfigSection = () => {};",
            shortCircuit: true,
          };
        }
        return nextResolve(specifier, context);
      },
    });
    statusModulePromise = import("../../src/status.ts");
  }
  return statusModulePromise;
}

class ProbeGatewayClient extends EventEmitter {
  state = "DISCONNECTED";
  sent = [];
  connectMode = "ready";

  async connect() {
    this.state = "CONNECTING";
    this.emit("stateChange", this.state);
    if (this.connectMode === "pending") {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
    this.state = "READY";
    this.emit("stateChange", this.state);
  }

  disconnect() {
    this.state = "DISCONNECTED";
    this.emit("stateChange", this.state);
  }

  send(message) {
    this.sent.push(message);
  }

  isConnected() {
    return this.state === "READY" || this.state === "CONNECTED";
  }

  getState() {
    return this.state;
  }

  getStatus() {
    return {
      isReady: () => this.state === "READY",
    };
  }
}

const logger = {
  info() {},
  warn() {},
  error() {},
};

function createAccount(overrides = {}) {
  return {
    accountId: "acct-a",
    enabled: true,
    debug: false,
    gateway: {
      url: "ws://gateway.local/ws",
    },
    auth: {
      ak: "ak-shared",
      sk: "sk",
    },
    agentIdPrefix: "tool",
    runTimeoutMs: 1000,
    ...overrides,
  };
}

test("probeMessageBridgeAccount reuses active runtime before creating a temporary probe", async () => {
  const { probeMessageBridgeAccount } = await loadStatusModule();
  __resetConnectionCoordinatorForTests();
  let activeProbeCalls = 0;
  let factoryCalls = 0;
  const result = await probeMessageBridgeAccount(
    {
      account: createAccount(),
      timeoutMs: 50,
      logger,
      activeRuntime: {
        async probe() {
          activeProbeCalls += 1;
          return {
            state: "ready",
            latencyMs: 1,
            reason: "active_runtime",
          };
        },
      },
    },
    {
      connectionFactory: () => {
        factoryCalls += 1;
        return new ProbeGatewayClient();
      },
    },
  );

  assert.equal(activeProbeCalls, 1);
  assert.equal(factoryCalls, 0);
  assert.deepEqual(result, {
    ok: true,
    state: "ready",
    latencyMs: 1,
    reason: "active_runtime",
  });
});

test("probeMessageBridgeAccount creates a temporary runtime for inactive accounts", async () => {
  const { probeMessageBridgeAccount } = await loadStatusModule();
  __resetConnectionCoordinatorForTests();
  let factoryCalls = 0;
  const result = await probeMessageBridgeAccount(
    {
      account: createAccount(),
      timeoutMs: 50,
      logger,
    },
    {
      connectionFactory: () => {
        factoryCalls += 1;
        return new ProbeGatewayClient();
      },
    },
  );

  assert.equal(factoryCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.state, "ready");
});

test("temporary probe cancellation is keyed by gateway url and ak", async () => {
  const { probeMessageBridgeAccount } = await loadStatusModule();
  __resetConnectionCoordinatorForTests();
  const account = createAccount();
  const probeConnection = new ProbeGatewayClient();
  probeConnection.connectMode = "pending";
  const probe = probeMessageBridgeAccount(
    {
      account,
      timeoutMs: 5_000,
      logger,
    },
    {
      connectionFactory: () => probeConnection,
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelProbeForRuntimeStart(buildMessageBridgeResourceKey(createAccount({ accountId: "acct-b" }))), true);
  const result = await probe;

  assert.equal(result.ok, false);
  assert.equal(result.state, "cancelled");
  assert.equal(result.reason, "probe_cancelled_for_runtime_start");
});

test("probe cancellation still wins when runtime creation has not settled yet", async () => {
  const { probeMessageBridgeAccount } = await loadStatusModule();
  __resetConnectionCoordinatorForTests();
  const account = createAccount();
  let resolveRuntime;
  let stopCalls = 0;

  const probe = probeMessageBridgeAccount(
    {
      account,
      timeoutMs: 5_000,
      logger,
    },
    {
      createRuntime: () =>
        new Promise((resolve) => {
          resolveRuntime = () =>
            resolve({
              async probe() {
                return {
                  state: "ready",
                  latencyMs: 1,
                  reason: "should_not_run",
                };
              },
              async stop() {
                stopCalls += 1;
              },
            });
        }),
    },
  );

  assert.equal(cancelProbeForRuntimeStart(buildMessageBridgeResourceKey(account)), true);
  resolveRuntime();
  const result = await probe;

  assert.equal(result.ok, false);
  assert.equal(result.state, "cancelled");
  assert.equal(result.reason, "probe_cancelled_for_runtime_start");
  assert.equal(stopCalls, 1);
});

test("probe ignores runtime snapshot that belongs to an old resource key", async () => {
  const { probeMessageBridgeAccount } = await loadStatusModule();
  __resetConnectionCoordinatorForTests();
  const currentAccount = createAccount({
    gateway: {
      url: "ws://new-gateway.local/ws",
    },
    auth: {
      ak: "new-ak",
      sk: "sk",
    },
  });
  const staleAccount = createAccount();
  updateRuntimeSnapshot(buildMessageBridgeResourceKey(staleAccount), {
    accountId: staleAccount.accountId,
    running: true,
    connected: true,
    runtimePhase: "ready",
    lastStartAt: 1,
    lastStopAt: null,
    lastError: null,
    lastReadyAt: Date.now(),
    lastInboundAt: null,
    lastOutboundAt: null,
    lastHeartbeatAt: null,
    probe: null,
    lastProbeAt: null,
  });

  let factoryCalls = 0;
  const result = await probeMessageBridgeAccount(
    {
      account: currentAccount,
      timeoutMs: 50,
      logger,
      runtime: getRuntimeSnapshot(buildMessageBridgeResourceKey(currentAccount)),
    },
    {
      connectionFactory: () => {
        factoryCalls += 1;
        return new ProbeGatewayClient();
      },
    },
  );

  assert.equal(factoryCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reason, "probe_connected");
});
