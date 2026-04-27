import assert from "node:assert/strict";
import test from "node:test";
import type { QrCodeAuth, QrCodeAuthSnapshot } from "../src/index.ts";
import { createQrCodeAuthRuntime } from "../src/internal/createQrCodeAuthRuntime.ts";

test("integration run emits terminal snapshot before resolve", async () => {
  const snapshots: QrCodeAuthSnapshot[] = [];
  const order: string[] = [];
  const auth = createQrCodeAuthRuntime({
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/qrcode")) {
        return new Response(JSON.stringify({
          code: "200",
          data: {
            accessToken: "token-1",
            qrcode: "qr-1",
            weUrl: "https://we.example/qr-1",
            pcUrl: "https://pc.example/qr-1",
            expireTime: "2026-04-24T00:00:00.000Z",
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: "200",
        data: {
          qrcode: "qr-1",
          status: 2,
          expired: "false",
          ak: "ak-1",
          sk: "sk-1",
        },
      }), { status: 200 });
    },
    wait: async () => {},
  });

  await auth.run({
    channel: "opencode",
    mac: "",
    onSnapshot(snapshot) {
      snapshots.push(snapshot);
      order.push(snapshot.type);
    },
  });

  order.push("resolved");

  assert.deepStrictEqual(order, [
    "qrcode_generated",
    "confirmed",
    "resolved",
  ]);
  assert.equal(snapshots.at(-1)?.type, "confirmed");
});

test("public qrcodeAuth creates isolated session state for repeated runs", async () => {
  const runSnapshots: QrCodeAuthSnapshot[][] = [];
  let nextRun = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/qrcode")) {
      nextRun += 1;
      return new Response(JSON.stringify({
        code: "200",
        data: {
          accessToken: `token-${nextRun}`,
          qrcode: `qr-${nextRun}`,
          weUrl: `https://we.example/qr-${nextRun}`,
          pcUrl: `https://pc.example/qr-${nextRun}`,
          expireTime: "2026-04-24T00:00:00.000Z",
        },
      }));
    }
    const qrcode = url.endsWith("/qr-1") ? "qr-1" : "qr-2";
    return new Response(JSON.stringify({
      code: "200",
      data: {
        qrcode,
        status: 2,
        expired: "false",
        ak: `${qrcode}-ak`,
        sk: `${qrcode}-sk`,
      },
    }));
  }) as typeof fetch;

  try {
    const imported = await import(`../src/index.ts?isolated=${Date.now()}`);
    const runtime = imported.qrcodeAuth as QrCodeAuth;

    for (let index = 0; index < 2; index += 1) {
      const snapshots: QrCodeAuthSnapshot[] = [];
      runSnapshots.push(snapshots);
      await runtime.run({
        channel: "opencode",
        mac: "",
        policy: {
          pollIntervalMs: 1,
        },
        onSnapshot(snapshot) {
          snapshots.push(snapshot);
        },
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepStrictEqual(runSnapshots.map((snapshots) => snapshots.map((snapshot) => snapshot.type)), [
    ["qrcode_generated", "confirmed"],
    ["qrcode_generated", "confirmed"],
  ]);
  assert.deepStrictEqual(runSnapshots.map((snapshots) => snapshots[0]?.qrcode), ["qr-1", "qr-2"]);
});
