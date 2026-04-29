import assert from "node:assert/strict";
import test from "node:test";
import { HttpQrCodeAuthService } from "../src/internal/HttpQrCodeAuthService.ts";

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
    serviceError: {
      message: "socket hang up",
    },
  });
});

test("http adapter maps fetch failure code and message to network_error serviceError", async () => {
  const service = new HttpQrCodeAuthService(async () => {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:443") as Error & { code?: string };
    error.code = "ECONNREFUSED";
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

test("http adapter maps string fetch failure to network_error serviceError", async () => {
  const service = new HttpQrCodeAuthService(async () => {
    throw "network down";
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
      message: "network down",
    },
  });
});

test("http adapter keeps parse error message for 2xx invalid json response", async () => {
  const service = new HttpQrCodeAuthService(async () => invalidJsonResponse("<html>gateway error</html>"));

  const result = await service.createSession({
    baseUrl: "https://auth.example.com",
    channel: "opencode",
    mac: "",
  });

  assert.equal(result.kind, "failed");
  assert.equal(result.reasonCode, "auth_service_error");
  assert.equal(result.serviceError?.httpStatus, 200);
  assert.match(result.serviceError?.message ?? "", /Unexpected token '<'/);
  assert.match(result.serviceError?.message ?? "", /is not valid JSON/);
});

test("http adapter keeps parse error message for non-2xx invalid json response", async () => {
  const service = new HttpQrCodeAuthService(async () => invalidJsonResponse("<html>bad gateway</html>", { status: 502 }));

  const result = await service.createSession({
    baseUrl: "https://auth.example.com",
    channel: "opencode",
    mac: "",
  });

  assert.equal(result.kind, "failed");
  assert.equal(result.reasonCode, "auth_service_error");
  assert.equal(result.serviceError?.httpStatus, 502);
  assert.match(result.serviceError?.message ?? "", /Unexpected token '<'/);
  assert.match(result.serviceError?.message ?? "", /is not valid JSON/);
});

test("http adapter keeps parse error code and message when response json throws", async () => {
  const service = new HttpQrCodeAuthService(async () => ({
    ok: true,
    status: 200,
    async json() {
      const error = new Error("Unexpected token < in JSON at position 0") as Error & { code?: string };
      error.code = "ERR_INVALID_JSON";
      throw error;
    },
  } as Response));

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
      code: "ERR_INVALID_JSON",
      message: "Unexpected token < in JSON at position 0",
    },
  });
});
