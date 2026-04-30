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

test("createNodeRequestInvocation does not add tls options for http", () => {
  const invocation = createNodeRequestInvocation("http://auth.example.com/qrcode", {
    method: "GET",
  });

  assert.equal(invocation.protocol, "http:");
  assert.equal(invocation.options.method, "GET");
  assert.equal(invocation.options.path, "/qrcode");
  assert.equal("rejectUnauthorized" in invocation.options, false);
});

test("createNodeRequestInvocation rejects unsupported protocols", () => {
  assert.throws(
    () => createNodeRequestInvocation("ws://auth.example.com/qrcode"),
    /http: and https:|ws:/,
  );
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

test("createNodeRequestFetch routes http requests without tls options", async () => {
  let received: NodeRequestInvocation | null = null;
  const fetchLike = createNodeRequestFetch({
    async http(invocation) {
      received = invocation;
      return jsonResponse({ code: "200", data: {} });
    },
    async https() {
      throw new Error("https should not be used");
    },
  });

  await fetchLike("http://auth.example.com", { method: "GET" });

  assert.equal(received?.protocol, "http:");
  assert.equal(received?.options.method, "GET");
  assert.equal("rejectUnauthorized" in (received?.options ?? {}), false);
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

test("http adapter accepts numeric success business code on create", async () => {
  const service = new HttpQrCodeAuthService(async () => jsonResponse({
    code: 200,
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

  assert.equal(result.kind, "created");
});

test("http adapter maps expired query from successful response", async () => {
  const service = new HttpQrCodeAuthService(async () => jsonResponse({
    code: "200",
    data: {
      qrcode: "qr-1",
      status: 0,
      expired: "true",
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
    kind: "expired",
    qrcode: "qr-1",
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

test("http adapter maps confirmed without credentials to auth_service_error", async () => {
  const service = new HttpQrCodeAuthService(async () => jsonResponse({
    code: "200",
    data: {
      qrcode: "qr-1",
      status: 2,
      ak: "ak-only",
      sk: "",
      expired: "false",
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
    kind: "failed",
    qrcode: "qr-1",
    reasonCode: "auth_service_error",
    serviceError: {
      httpStatus: 200,
      businessCode: "200",
    },
  });
});

test("http adapter uses raw qrcode in query path without encoding", async () => {
  const requestedUrls: string[] = [];
  const service = new HttpQrCodeAuthService(async (input) => {
    requestedUrls.push(String(input));
    return jsonResponse({
      code: "200",
      data: {
        qrcode: "qr/a+b=%20",
        status: 0,
        expired: "false",
      },
    });
  });

  await service.querySession({
    baseUrl: "https://auth.example.com",
    ref: {
      qrcode: "qr/a+b=%20",
      accessToken: "token-1",
    },
  });

  assert.equal(
    requestedUrls[0],
    "https://auth.example.com/assistant-api/nologin/we-crew/im-register/qrcode-detail/qr/a+b=%20",
  );
});

test("http adapter maps string query status to auth_service_error", async () => {
  const service = new HttpQrCodeAuthService(async () => jsonResponse({
    code: "200",
    data: {
      qrcode: "qr-1",
      status: "confirmed",
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
    kind: "failed",
    qrcode: "qr-1",
    reasonCode: "auth_service_error",
    serviceError: {
      httpStatus: 200,
      businessCode: "200",
    },
  });
});

test("http adapter maps missing query status to auth_service_error", async () => {
  const service = new HttpQrCodeAuthService(async () => jsonResponse({
    code: "200",
    data: {
      qrcode: "qr-1",
      expired: "false",
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
    kind: "failed",
    qrcode: "qr-1",
    reasonCode: "auth_service_error",
    serviceError: {
      httpStatus: 200,
      businessCode: "200",
    },
  });
});

test("http adapter maps unknown numeric query status to auth_service_error", async () => {
  const service = new HttpQrCodeAuthService(async () => jsonResponse({
    code: "200",
    data: {
      qrcode: "qr-1",
      status: 99,
      expired: "false",
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
    kind: "failed",
    qrcode: "qr-1",
    reasonCode: "auth_service_error",
    serviceError: {
      httpStatus: 200,
      businessCode: "200",
    },
  });
});

test("http adapter maps non-200 business code to auth_service_error", async () => {
  const service = new HttpQrCodeAuthService(async () => jsonResponse({
    code: "585704",
    error: "invalid_qrcode",
    message: "invalid",
  }));

  const result = await service.querySession({
    baseUrl: "https://auth.example.com",
    ref: {
      qrcode: "qr-1",
      accessToken: "token-1",
    },
  });

  assert.deepStrictEqual(result, {
    kind: "failed",
    qrcode: "qr-1",
    reasonCode: "auth_service_error",
    serviceError: {
      httpStatus: 200,
      businessCode: "585704",
      error: "invalid_qrcode",
      message: "invalid",
    },
  });
});

test("http adapter stringifies numeric business code in service error", async () => {
  const service = new HttpQrCodeAuthService(async () => jsonResponse({
    code: 585704,
    error: "invalid_qrcode",
    message: "invalid",
  }));

  const result = await service.querySession({
    baseUrl: "https://auth.example.com",
    ref: {
      qrcode: "qr-1",
      accessToken: "token-1",
    },
  });

  assert.deepStrictEqual(result, {
    kind: "failed",
    qrcode: "qr-1",
    reasonCode: "auth_service_error",
    serviceError: {
      httpStatus: 200,
      businessCode: "585704",
      error: "invalid_qrcode",
      message: "invalid",
    },
  });
});

test("http adapter maps fetch failure to network_error", async () => {
  const service = new HttpQrCodeAuthService(async () => {
    throw new Error("socket hang up");
  });

  const result = await service.createSession({
    baseUrl: "https://auth.example.com",
    channel: "opencode",
    mac: "",
  });

  assert.deepStrictEqual(result, {
    kind: "failed",
    reasonCode: "network_error",
  });
});
