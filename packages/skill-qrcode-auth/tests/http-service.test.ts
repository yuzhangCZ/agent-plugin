import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpQrCodeAuthService,
  INSECURE_TLS_REQUEST_OPTIONS,
  createNodeRequestFetch,
  createNodeRequestInvocation,
  type NodeRequestInvocation,
} from "../src/internal/HttpQrCodeAuthService.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

function invalidJsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

test("default tls request options disable certificate verification", () => {
  assert.deepStrictEqual(INSECURE_TLS_REQUEST_OPTIONS, {
    rejectUnauthorized: false,
  });
});

test("createNodeRequestInvocation keeps request fields for https", () => {
  const invocation = createNodeRequestInvocation("https://auth.example.com/qrcode?step=1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: '{"hello":"world"}',
  });

  assert.equal(invocation.protocol, "https:");
  assert.equal(invocation.options.method, "POST");
  assert.equal(invocation.options.path, "/qrcode?step=1");
  assert.deepStrictEqual(invocation.options.headers, {
    "content-type": "application/json",
  });
  assert.equal(invocation.options.rejectUnauthorized, false);
  assert.equal(invocation.bodyText, '{"hello":"world"}');
});

test("createNodeRequestFetch routes https requests with insecure tls option", async () => {
  let received: NodeRequestInvocation | null = null;
  const fetchLike = createNodeRequestFetch({
    async http() {
      throw new Error("http should not be used");
    },
    async https(invocation) {
      received = invocation;
      return jsonResponse({ code: "200", data: {} });
    },
  });

  await fetchLike("https://auth.example.com", { method: "GET" });

  assert.equal(received?.protocol, "https:");
  assert.equal(received?.options.method, "GET");
  assert.equal(received?.options.rejectUnauthorized, false);
});

test("http adapter converts create success response", async () => {
  const service = new HttpQrCodeAuthService(async () => jsonResponse({
    code: "200",
    data: {
      accessToken: "token-1",
      qrcode: "qr-1",
      weUrl: "https://we.example/qr-1",
      pcUrl: "https://pc.example/qr-1",
      expireTime: "2026-04-24T00:00:00.000Z",
    },
  }));

  const result = await service.createSession({
    baseUrl: "https://auth.example.com",
    channel: "opencode",
    mac: "",
  });

  assert.deepStrictEqual(result, {
    kind: "created",
    session: {
      ref: {
        qrcode: "qr-1",
        accessToken: "token-1",
      },
      display: {
        qrcode: "qr-1",
        weUrl: "https://we.example/qr-1",
        pcUrl: "https://pc.example/qr-1",
      },
      expiresAt: "2026-04-24T00:00:00.000Z",
    },
  });
});

test("http adapter accepts numeric success business code on query", async () => {
  const service = new HttpQrCodeAuthService(async () => jsonResponse({
    code: 200,
    data: {
      qrcode: "qr-1",
      status: 2,
      expired: "false",
      ak: "ak-1",
      sk: "sk-1",
    },
  }));

  const result = await service.querySession({
    baseUrl: "https://auth.example.com",
    ref: {
      qrcode: "qr-1",
      accessToken: "token-1",
    },
  });

  assert.deepStrictEqual(result, {
    kind: "confirmed",
    qrcode: "qr-1",
    credentials: {
      ak: "ak-1",
      sk: "sk-1",
    },
  });
});

test("http adapter returns network_error summary fields on fetch failure", async () => {
  const error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
  const service = new HttpQrCodeAuthService(async () => {
    throw error;
  });

  const result = await service.createSession({
    baseUrl: "https://auth.example.com",
    channel: "opencode",
    mac: "",
  });

  assert.deepStrictEqual(result, {
    kind: "failed",
    reasonCode: "network_error",
    serviceError: {
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED 127.0.0.1:443",
    },
  });
});

test("http adapter maps invalid json response to auth_service_error with parse summary", async () => {
  const service = new HttpQrCodeAuthService(async () => invalidJsonResponse("{invalid json"));

  const result = await service.createSession({
    baseUrl: "https://auth.example.com",
    channel: "opencode",
    mac: "",
  });

  assert.deepStrictEqual(result, {
    kind: "failed",
    reasonCode: "auth_service_error",
    serviceError: {
      httpStatus: 200,
      message: "Failed to parse JSON response",
    },
  });
});
