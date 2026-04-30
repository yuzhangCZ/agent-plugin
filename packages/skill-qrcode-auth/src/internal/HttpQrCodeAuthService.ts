import { request as httpRequest, type RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import type {
  QrCodeAuthServiceError,
  QrCodeDisplayData,
} from "../types.ts";
import type {
  CreateQrCodeSessionResult,
  QrCodeAuthFailureResult,
  QrCodeAuthServicePort,
  QueryQrCodeSessionResult,
  QrCodeSessionRef,
} from "./service-port.ts";

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export const INSECURE_TLS_REQUEST_OPTIONS = {
  rejectUnauthorized: false,
} as const;

interface AuthResponseBody {
  code?: unknown;
  error?: unknown;
  errorEn?: unknown;
  message?: unknown;
  data?: Record<string, unknown> | null;
}

export interface NodeRequestInvocation {
  bodyText?: string;
  options: HttpRequestOptions | HttpsRequestOptions;
  protocol: "http:" | "https:";
  url: URL;
}

export interface NodeRequestTransport {
  http(input: NodeRequestInvocation): Promise<Response>;
  https(input: NodeRequestInvocation): Promise<Response>;
}

/**
 * HTTP adapter 负责远端协议转换和 accessToken 管理。
 */
export class HttpQrCodeAuthService implements QrCodeAuthServicePort {
  private readonly fetchImpl: FetchLike;

  public constructor(fetchImpl: FetchLike = createNodeRequestFetch()) {
    this.fetchImpl = fetchImpl;
  }

  public async createSession(input: {
    baseUrl: string;
    channel: string;
    mac: string;
  }): Promise<CreateQrCodeSessionResult> {
    const response = await this.requestJson({
      url: new URL("/assistant-api/nologin/we-crew/im-register/qrcode", normalizeBaseUrl(input.baseUrl)),
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          channel: input.channel,
          mac: input.mac,
        }),
      },
    });
    if ("kind" in response) {
      return response;
    }

    const serviceError = buildServiceError(response.status, response.body);
    if (readCode(response.body) !== "200") {
      return {
        kind: "failed",
        reasonCode: "auth_service_error",
        ...(hasServiceError(serviceError) ? { serviceError } : {}),
      };
    }

    const data = response.body.data;
    const qrcode = readString(data?.qrcode);
    const accessToken = readString(data?.accessToken);
    const display = readDisplayData(data);
    const expiresAt = readString(data?.expireTime);
    if (!qrcode || !accessToken || !display || !expiresAt) {
      return {
        kind: "failed",
        reasonCode: "auth_service_error",
        ...(hasServiceError(serviceError) ? { serviceError } : {}),
      };
    }

    return {
      kind: "created",
      session: {
        ref: {
          qrcode,
          accessToken,
        },
        display,
        expiresAt,
      },
    };
  }

  public async querySession(input: {
    baseUrl: string;
    ref: QrCodeSessionRef;
  }): Promise<QueryQrCodeSessionResult> {
    const response = await this.requestJson({
      url: new URL(
        // 服务端保证 qrcode 不含 URL 保留字符；这里按原值拼接路径，不做编码。
        `/assistant-api/nologin/we-crew/im-register/qrcode-detail/${input.ref.qrcode}`,
        normalizeBaseUrl(input.baseUrl),
      ),
      init: {
        method: "GET",
        headers: {
          qrcodeToken: input.ref.accessToken,
        },
      },
    });
    if ("kind" in response) {
      return {
        ...response,
        ...(input.ref.qrcode ? { qrcode: input.ref.qrcode } : {}),
      };
    }

    const serviceError = buildServiceError(response.status, response.body);
    if (readCode(response.body) !== "200") {
      return {
        kind: "failed",
        qrcode: input.ref.qrcode,
        reasonCode: "auth_service_error",
        ...(hasServiceError(serviceError) ? { serviceError } : {}),
      };
    }

    const data = response.body.data;
    const qrcode = readString(data?.qrcode);
    if (!qrcode) {
      return {
        kind: "failed",
        qrcode: input.ref.qrcode,
        reasonCode: "auth_service_error",
        ...(hasServiceError(serviceError) ? { serviceError } : {}),
      };
    }

    if (readExpiredFlag(data?.expired)) {
      return {
        kind: "expired",
        qrcode,
      };
    }

    switch (readStatusCode(data?.status)) {
      case 0:
        return {
          kind: "waiting",
          qrcode,
        };
      case 1:
        return {
          kind: "scanned",
          qrcode,
        };
      case 3:
        return {
          kind: "cancelled",
          qrcode,
        };
      case 2: {
        const ak = readString(data?.ak);
        const sk = readString(data?.sk);
        if (!ak || !sk) {
          return {
            kind: "failed",
            qrcode,
            reasonCode: "auth_service_error",
            ...(hasServiceError(serviceError) ? { serviceError } : {}),
          };
        }
        return {
          kind: "confirmed",
          qrcode,
          credentials: { ak, sk },
        };
      }
      default:
        return {
          kind: "failed",
          qrcode,
          reasonCode: "auth_service_error",
          ...(hasServiceError(serviceError) ? { serviceError } : {}),
        };
    }
  }

  private async requestJson(input: {
    url: URL;
    init: RequestInit;
  }): Promise<
    | {
        status: number;
        body: AuthResponseBody;
      }
    | QrCodeAuthFailureResult
  > {
    let response: Response;
    try {
      response = await this.fetchImpl(input.url, input.init);
    } catch {
      return {
        kind: "failed",
        reasonCode: "network_error",
      };
    }

    const body = await parseJsonBody(response);
    if (!response.ok || !body) {
      const serviceError = body ? buildServiceError(response.status, body) : { httpStatus: response.status };
      return {
        kind: "failed",
        reasonCode: "auth_service_error",
        ...(hasServiceError(serviceError) ? { serviceError } : {}),
      };
    }

    return {
      status: response.status,
      body,
    };
  }
}

/**
 * 默认对授权服务请求关闭证书校验，兼容企业内网自签或未下发系统信任链的部署环境。
 */
export function createNodeRequestFetch(
  transport: NodeRequestTransport = defaultNodeRequestTransport,
): FetchLike {
  return async (input, init) => {
    const invocation = createNodeRequestInvocation(input, init);
    if (invocation.protocol === "https:") {
      return transport.https(invocation);
    }
    return transport.http(invocation);
  };
}

export function createNodeRequestInvocation(
  input: string | URL,
  init?: RequestInit,
): NodeRequestInvocation {
  const url = input instanceof URL ? input : new URL(input);
  const method = init?.method ?? "GET";
  const headers = toNodeHeaders(init?.headers);
  const bodyText = toBodyText(init?.body);
  const options: HttpRequestOptions | HttpsRequestOptions = {
    headers,
    method,
    path: `${url.pathname}${url.search}`,
  };

  if (url.protocol === "https:") {
    return {
      bodyText,
      options: {
        ...options,
        ...INSECURE_TLS_REQUEST_OPTIONS,
      },
      protocol: "https:",
      url,
    };
  }

  if (url.protocol !== "http:") {
    throw new TypeError(`QrCodeAuth HTTP transport only supports http: and https: URLs, got ${url.protocol}`);
  }

  return {
    bodyText,
    options,
    protocol: "http:",
    url,
  };
}

const defaultNodeRequestTransport: NodeRequestTransport = {
  http(input) {
    return executeNodeRequest(input, httpRequest);
  },
  https(input) {
    return executeNodeRequest(input, httpsRequest);
  },
};

async function executeNodeRequest(
  input: NodeRequestInvocation,
  requestImpl: typeof httpRequest | typeof httpsRequest,
): Promise<Response> {
  return await new Promise((resolve, reject) => {
    const request = requestImpl(input.url, input.options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve(new Response(body, {
          headers: toResponseHeaders(response.headers),
          status: response.statusCode ?? 500,
          statusText: response.statusMessage ?? "",
        }));
      });
      response.on("error", reject);
    });

    request.on("error", reject);
    if (input.bodyText) {
      request.write(input.bodyText);
    }
    request.end();
  });
}

async function parseJsonBody(response: Response): Promise<AuthResponseBody | null> {
  try {
    return (await response.json()) as AuthResponseBody;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function toNodeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(new Headers(headers).entries());
}

function toResponseHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const normalized = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized.append(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        normalized.append(key, item);
      }
    }
  }
  return normalized;
}

function toBodyText(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }

  throw new TypeError("QrCodeAuth HTTP transport only supports string request bodies.");
}

function readCode(body: AuthResponseBody): string {
  return normalizeBusinessCode(body.code);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStatusCode(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function readDisplayData(data: Record<string, unknown> | null | undefined): QrCodeDisplayData | null {
  const qrcode = readString(data?.qrcode);
  const weUrl = readString(data?.weUrl);
  const pcUrl = readString(data?.pcUrl);
  if (!qrcode || !weUrl || !pcUrl) {
    return null;
  }
  return {
    qrcode,
    weUrl,
    pcUrl,
  };
}

function readExpiredFlag(value: unknown): boolean {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function buildServiceError(httpStatus: number, body: AuthResponseBody): QrCodeAuthServiceError {
  const businessCode = normalizeBusinessCode(body.code);
  return {
    httpStatus,
    ...(businessCode ? { businessCode } : {}),
    ...(typeof body.error === "string" ? { error: body.error } : {}),
    ...(typeof body.message === "string" ? { message: body.message } : {}),
    ...(typeof body.errorEn === "string" ? { errorEn: body.errorEn } : {}),
  };
}

function normalizeBusinessCode(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function hasServiceError(error: QrCodeAuthServiceError): boolean {
  return Object.keys(error).length > 0;
}
