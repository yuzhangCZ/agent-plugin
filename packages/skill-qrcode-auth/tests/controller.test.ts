import assert from "node:assert/strict";
import test from "node:test";
import { QrCodeAuthSessionController } from "../src/internal/QrCodeAuthSessionController.ts";
import { buildSnapshotKey } from "../src/internal/buildSnapshotKey.ts";
import type {
  CreateQrCodeSessionResult,
  QrCodeAuthServicePort,
  QueryQrCodeSessionResult,
} from "../src/internal/service-port.ts";
import type { QrCodeAuthSnapshot } from "../src/index.ts";

function createService(input: {
  createResults: CreateQrCodeSessionResult[];
  queryResults: QueryQrCodeSessionResult[];
}): QrCodeAuthServicePort {
  const createResults = [...input.createResults];
  const queryResults = [...input.queryResults];

  return {
    async createSession() {
      const result = createResults.shift();
      assert.ok(result, "expected create session result");
      return result;
    },
    async querySession() {
      const result = queryResults.shift();
      assert.ok(result, "expected query session result");
      return result;
    },
  };
}

function created(qrcode: string): CreateQrCodeSessionResult {
  return {
    kind: "created",
    session: {
      ref: {
        qrcode,
        accessToken: `${qrcode}-token`,
      },
      display: {
        qrcode,
        weUrl: `https://we.example/${qrcode}`,
        pcUrl: `https://pc.example/${qrcode}`,
      },
      expiresAt: "2026-04-24T00:00:00.000Z",
    },
  };
}

test("controller emits qrcode_generated -> scanned -> confirmed and resolves after terminal snapshot", async () => {
  const snapshots: QrCodeAuthSnapshot[] = [];
  const markers: string[] = [];
  const controller = new QrCodeAuthSessionController({
    service: createService({
      createResults: [created("qr-1")],
      queryResults: [
        { kind: "waiting", qrcode: "qr-1" },
        { kind: "scanned", qrcode: "qr-1" },
        { kind: "confirmed", qrcode: "qr-1", credentials: { ak: "ak-1", sk: "sk-1" } },
      ],
    }),
    baseUrl: "https://auth.example.com",
    channel: "openclaw",
    mac: "",
    policy: {
      refreshOnExpired: true,
      maxRefreshCount: 3,
      pollIntervalMs: 1,
    },
    onSnapshot(snapshot) {
      snapshots.push(snapshot);
      markers.push(snapshot.type);
    },
    wait: async () => {},
  });

  await controller.start();
  markers.push("resolved");

  assert.deepStrictEqual(markers, [
    "qrcode_generated",
    "scanned",
    "confirmed",
    "resolved",
  ]);
});

test("controller refreshes expired qrcode and emits new qrcode_generated", async () => {
  const snapshots: QrCodeAuthSnapshot[] = [];
  const controller = new QrCodeAuthSessionController({
    service: createService({
      createResults: [created("qr-1"), created("qr-2")],
      queryResults: [
        { kind: "expired", qrcode: "qr-1" },
        { kind: "confirmed", qrcode: "qr-2", credentials: { ak: "ak-2", sk: "sk-2" } },
      ],
    }),
    baseUrl: "https://auth.example.com",
    channel: "opencode",
    mac: "",
    policy: {
      refreshOnExpired: true,
      maxRefreshCount: 1,
      pollIntervalMs: 1,
    },
    onSnapshot(snapshot) {
      snapshots.push(snapshot);
    },
    wait: async () => {},
  });

  await controller.start();

  assert.deepStrictEqual(
    snapshots.map((item) => item.type === "qrcode_generated" ? `${item.type}:${item.qrcode}` : item.type),
    ["qrcode_generated:qr-1", "expired", "qrcode_generated:qr-2", "confirmed"],
  );
});

test("controller converts expired exhaustion to failed timeout", async () => {
  const snapshots: QrCodeAuthSnapshot[] = [];
  const controller = new QrCodeAuthSessionController({
    service: createService({
      createResults: [created("qr-1")],
      queryResults: [{ kind: "expired", qrcode: "qr-1" }],
    }),
    baseUrl: "https://auth.example.com",
    channel: "opencode",
    mac: "",
    policy: {
      refreshOnExpired: true,
      maxRefreshCount: 0,
      pollIntervalMs: 1,
    },
    onSnapshot(snapshot) {
      snapshots.push(snapshot);
    },
    wait: async () => {},
  });

  await controller.start();

  assert.deepStrictEqual(snapshots, [
    {
      type: "qrcode_generated",
      qrcode: "qr-1",
      display: {
        qrcode: "qr-1",
        weUrl: "https://we.example/qr-1",
        pcUrl: "https://pc.example/qr-1",
      },
      expiresAt: "2026-04-24T00:00:00.000Z",
    },
    {
      type: "expired",
      qrcode: "qr-1",
    },
    {
      type: "failed",
      qrcode: "qr-1",
      reasonCode: "timeout",
    },
  ]);
});

test("controller closes on cancelled and deduplicates repeated scanned snapshots", async () => {
  const snapshots: QrCodeAuthSnapshot[] = [];
  const controller = new QrCodeAuthSessionController({
    service: createService({
      createResults: [created("qr-1")],
      queryResults: [
        { kind: "scanned", qrcode: "qr-1" },
        { kind: "scanned", qrcode: "qr-1" },
        { kind: "cancelled", qrcode: "qr-1" },
      ],
    }),
    baseUrl: "https://auth.example.com",
    channel: "openclaw",
    mac: "",
    policy: {
      refreshOnExpired: true,
      maxRefreshCount: 3,
      pollIntervalMs: 1,
    },
    onSnapshot(snapshot) {
      snapshots.push(snapshot);
    },
    wait: async () => {},
  });

  await controller.start();

  assert.deepStrictEqual(snapshots.map((item) => item.type), [
    "qrcode_generated",
    "scanned",
    "cancelled",
  ]);
});

test("snapshot key treats repeated expired snapshots for the same qrcode as duplicates", () => {
  assert.equal(
    buildSnapshotKey({ type: "expired", qrcode: "qr-1" }),
    buildSnapshotKey({ type: "expired", qrcode: "qr-1" }),
  );
  assert.notEqual(
    buildSnapshotKey({ type: "expired", qrcode: "qr-1" }),
    buildSnapshotKey({ type: "expired", qrcode: "qr-2" }),
  );
});

test("controller does not deduplicate same event type across different qrcodes", async () => {
  const snapshots: QrCodeAuthSnapshot[] = [];
  const controller = new QrCodeAuthSessionController({
    service: createService({
      createResults: [created("qr-1"), created("qr-2")],
      queryResults: [
        { kind: "scanned", qrcode: "qr-1" },
        { kind: "expired", qrcode: "qr-1" },
        { kind: "scanned", qrcode: "qr-2" },
        { kind: "confirmed", qrcode: "qr-2", credentials: { ak: "ak-2", sk: "sk-2" } },
      ],
    }),
    baseUrl: "https://auth.example.com",
    channel: "openclaw",
    mac: "",
    policy: {
      refreshOnExpired: true,
      maxRefreshCount: 1,
      pollIntervalMs: 1,
    },
    onSnapshot(snapshot) {
      snapshots.push(snapshot);
    },
    wait: async () => {},
  });

  await controller.start();

  assert.deepStrictEqual(
    snapshots.map((item) => item.type === "qrcode_generated" ? `${item.type}:${item.qrcode}` : `${item.type}:${item.qrcode ?? "session"}`),
    [
      "qrcode_generated:qr-1",
      "scanned:qr-1",
      "expired:qr-1",
      "qrcode_generated:qr-2",
      "scanned:qr-2",
      "confirmed:qr-2",
    ],
  );
});

test("controller emits service failures as terminal snapshots", async () => {
  const snapshots: QrCodeAuthSnapshot[] = [];
  const controller = new QrCodeAuthSessionController({
    service: createService({
      createResults: [created("qr-1")],
      queryResults: [
        {
          kind: "failed",
          qrcode: "qr-1",
          reasonCode: "network_error",
        },
      ],
    }),
    baseUrl: "https://auth.example.com",
    channel: "opencode",
    mac: "",
    policy: {
      refreshOnExpired: true,
      maxRefreshCount: 3,
      pollIntervalMs: 1,
    },
    onSnapshot(snapshot) {
      snapshots.push(snapshot);
    },
    wait: async () => {},
  });

  await controller.start();

  assert.deepStrictEqual(snapshots.at(-1), {
    type: "failed",
    qrcode: "qr-1",
    reasonCode: "network_error",
  });
});

test("snapshot key deduplicates failed snapshots by qrcode and reasonCode", () => {
  assert.equal(
    buildSnapshotKey({
      type: "failed",
      qrcode: "qr-1",
      reasonCode: "auth_service_error",
    }),
    buildSnapshotKey({
      type: "failed",
      qrcode: "qr-1",
      reasonCode: "auth_service_error",
    }),
  );
  assert.notEqual(
    buildSnapshotKey({
      type: "failed",
      qrcode: "qr-1",
      reasonCode: "auth_service_error",
    }),
    buildSnapshotKey({
      type: "failed",
      qrcode: "qr-1",
      reasonCode: "network_error",
    }),
  );
  assert.notEqual(
    buildSnapshotKey({
      type: "failed",
      qrcode: "qr-1",
      reasonCode: "auth_service_error",
    }),
    buildSnapshotKey({
      type: "failed",
      qrcode: "qr-2",
      reasonCode: "auth_service_error",
    }),
  );
});
