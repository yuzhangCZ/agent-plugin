import assert from "node:assert/strict";
import test from "node:test";
import { qrcodeAuth, type QrCodeAuthSnapshot } from "../src/index.ts";
import { createQrCodeAuthRuntime } from "../src/internal/createQrCodeAuthRuntime.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

test("facade validates required input", async () => {
  await assert.rejects(
    qrcodeAuth.run({
      baseUrl: "",
      channel: "opencode",
      mac: "",
      onSnapshot() {},
    }),
    /baseUrl/,
  );

  await assert.rejects(
    qrcodeAuth.run({
      baseUrl: "https://auth.example.com",
      channel: "",
      mac: "",
      onSnapshot() {},
    }),
    /channel/,
  );
});

test("facade merges default policy and resolves after terminal snapshot", async () => {
  const snapshots: QrCodeAuthSnapshot[] = [];
  const waits: number[] = [];
  const auth = createQrCodeAuthRuntime({
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/qrcode")) {
        return jsonResponse({
          code: "200",
          data: {
            accessToken: "token-1",
            qrcode: "qr-1",
            weUrl: "https://we.example/qr-1",
            pcUrl: "https://pc.example/qr-1",
            expireTime: "2026-04-24T00:00:00.000Z",
          },
        });
      }
      return jsonResponse({
        code: "200",
        data: {
          qrcode: "qr-1",
          status: "confirmed",
          expired: "false",
          ak: "ak-1",
          sk: "sk-1",
        },
      });
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  await auth.run({
    baseUrl: "https://auth.example.com/",
    channel: "openclaw",
    mac: "",
    onSnapshot(snapshot) {
      snapshots.push(snapshot);
    },
  });

  assert.deepStrictEqual(waits, [2_000]);
  assert.deepStrictEqual(snapshots.map((item) => item.type), ["qrcode_generated", "confirmed"]);
});

test("facade uses partial policy overrides", async () => {
  const waits: number[] = [];
  const auth = createQrCodeAuthRuntime({
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/qrcode")) {
        return jsonResponse({
          code: "200",
          data: {
            accessToken: "token-1",
            qrcode: "qr-1",
            weUrl: "https://we.example/qr-1",
            pcUrl: "https://pc.example/qr-1",
            expireTime: "2026-04-24T00:00:00.000Z",
          },
        });
      }
      return jsonResponse({
        code: "585704",
        error: "network_like_failure",
        message: "failed",
      });
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  await auth.run({
    baseUrl: "https://auth.example.com",
    channel: "opencode",
    mac: "",
    policy: {
      pollIntervalMs: 50,
    },
    onSnapshot() {},
  });

  assert.deepStrictEqual(waits, [50]);
});

test("facade rejects non-boolean refreshOnExpired string input", async () => {
  await assert.rejects(
    qrcodeAuth.run({
      baseUrl: "https://auth.example.com",
      channel: "opencode",
      mac: "",
      policy: {
        refreshOnExpired: "false" as unknown as boolean,
      },
      onSnapshot() {},
    }),
    /refreshOnExpired/,
  );
});

test("facade rejects non-boolean refreshOnExpired numeric input", async () => {
  await assert.rejects(
    qrcodeAuth.run({
      baseUrl: "https://auth.example.com",
      channel: "opencode",
      mac: "",
      policy: {
        refreshOnExpired: 1 as unknown as boolean,
      },
      onSnapshot() {},
    }),
    /refreshOnExpired/,
  );
});
