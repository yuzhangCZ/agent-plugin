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

interface AuthResponseBody {
  code?: unknown;
  error?: unknown;
  errorEn?: unknown;
  message?: unknown;
  data?: Record<string, unknown> | null;
}

/**
 * HTTP adapter 负责远端协议转换和 accessToken 管理。
 */
export class HttpQrCodeAuthService implements QrCodeAuthServicePort {
  private readonly fetchImpl: FetchLike;

  public constructor(fetchImpl: FetchLike = fetch) {
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
        `/assistant-api/nologin/we-crew/im-register/qrcode-detail/${encodeURIComponent(input.ref.qrcode)}`,
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

    switch (readString(data?.status)) {
      case "wait":
        return {
          kind: "waiting",
          qrcode,
        };
      case "scaned":
        return {
          kind: "scanned",
          qrcode,
        };
      case "cancel":
        return {
          kind: "cancelled",
          qrcode,
        };
      case "confirmed": {
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

function readCode(body: AuthResponseBody): string {
  return normalizeBusinessCode(body.code);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
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
