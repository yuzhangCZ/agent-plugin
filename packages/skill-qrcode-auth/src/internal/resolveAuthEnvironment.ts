import type { QrCodeAuthEnvironment } from "../types.ts";

const AUTH_BASE_URLS = {
  prod: "https://api.inner.welink.huawei.com",
  uat: "https://api.uat.welink.huawei.com",
} as const satisfies Record<QrCodeAuthEnvironment, string>;

/**
 * 统一管理公开环境枚举到远端授权服务地址的收敛映射。
 */
export function resolveAuthEnvironment(environment: QrCodeAuthEnvironment | undefined): {
  baseUrl: string;
  environment: QrCodeAuthEnvironment;
} {
  const resolvedEnvironment = environment ?? "prod";
  if (resolvedEnvironment !== "prod" && resolvedEnvironment !== "uat") {
    throw new TypeError("QrCodeAuth.run() requires environment to be one of: uat, prod.");
  }

  return {
    baseUrl: AUTH_BASE_URLS[resolvedEnvironment],
    environment: resolvedEnvironment,
  };
}
