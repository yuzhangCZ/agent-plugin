import assert from "node:assert/strict";
import test from "node:test";
import { qrcodeAuth, type QrCodeAuthSnapshot } from "../src/index.ts";
import { createQrCodeAuthRuntime } from "../src/internal/createQrCodeAuthRuntime.ts";
import type { QrCodeAuthServicePort } from "../src/internal/service-port.ts";

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
      environment: "staging" as unknown as "prod",
      channel: "opencode",
      mac: "",
      onSnapshot() {},
    }),
    /environment/,
  );

  await assert.rejects(
    qrcodeAuth.run({
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
          status: 2,
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
    channel: "opencode",
    mac: "",
    policy: {
      pollIntervalMs: 50,
    },
    onSnapshot() {},
  });

  assert.deepStrictEqual(waits, [50]);
});

test("facade prefers injected service port over default http adapter", async () => {
  const waits: number[] = [];
  let createCalls = 0;
  let queryCalls = 0;
  const service: QrCodeAuthServicePort = {
    async createSession() {
      createCalls += 1;
      return {
        kind: "created",
        session: {
          ref: {
            qrcode: "qr-service",
            accessToken: "token-service",
          },
          display: {
            qrcode: "qr-service",
            weUrl: "https://we.example/qr-service",
            pcUrl: "https://pc.example/qr-service",
          },
          expiresAt: "2026-04-24T00:00:00.000Z",
        },
      };
    },
    async querySession() {
      queryCalls += 1;
      return {
        kind: "confirmed",
        qrcode: "qr-service",
        credentials: {
          ak: "ak-service",
          sk: "sk-service",
        },
      };
    },
  };
  const auth = createQrCodeAuthRuntime({
    service,
    fetch: async () => {
      throw new Error("fetch should not be used when service is injected");
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  const snapshots: QrCodeAuthSnapshot[] = [];
  await auth.run({
    channel: "opencode",
    mac: "",
    onSnapshot(snapshot) {
      snapshots.push(snapshot);
    },
  });

  assert.equal(createCalls, 1);
  assert.equal(queryCalls, 1);
  assert.deepStrictEqual(waits, [2_000]);
  assert.deepStrictEqual(snapshots.map((snapshot) => snapshot.type), ["qrcode_generated", "confirmed"]);
});

test("facade rejects non-boolean refreshOnExpired string input", async () => {
  await assert.rejects(
    qrcodeAuth.run({
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

test("facade defaults environment to prod and resolves after terminal snapshot", async () => {
  const requestedUrls: string[] = [];
  const auth = createQrCodeAuthRuntime({
    fetch: async (input) => {
      const url = String(input);
      requestedUrls.push(url);
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
          status: 2,
          expired: "false",
          ak: "ak-1",
          sk: "sk-1",
        },
      });
    },
    wait: async () => {},
  });

  await auth.run({
    channel: "opencode",
    mac: "",
    onSnapshot() {},
  });

  assert.ok(requestedUrls.every((url) => url.startsWith("https://api.inner.welink.huawei.com/")));
});

test("facade resolves uat environment to fixed auth base url", async () => {
  const requestedUrls: string[] = [];
  const auth = createQrCodeAuthRuntime({
    fetch: async (input) => {
      const url = String(input);
      requestedUrls.push(url);
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
          status: 2,
          expired: "false",
          ak: "ak-1",
          sk: "sk-1",
        },
      });
    },
    wait: async () => {},
  });

  await auth.run({
    environment: "uat",
    channel: "opencode",
    mac: "",
    onSnapshot() {},
  });

  assert.ok(requestedUrls.every((url) => url.startsWith("https://api.uat.welink.huawei.com/")));
});
