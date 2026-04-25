import type { QrCodeAuth, QrCodeAuthPolicy, QrCodeAuthRunInput } from "../types.ts";
import { HttpQrCodeAuthService, type FetchLike } from "./HttpQrCodeAuthService.ts";
import { resolveAuthEnvironment } from "./resolveAuthEnvironment.ts";
import type { QrCodeAuthServicePort } from "./service-port.ts";
import { QrCodeAuthSessionController } from "./QrCodeAuthSessionController.ts";

const DEFAULT_POLICY: Required<QrCodeAuthPolicy> = {
  refreshOnExpired: true,
  maxRefreshCount: 3,
  pollIntervalMs: 2_000,
};

/**
 * 创建二维码授权 runtime。
 *
 * @remarks
 * `service` 是 application 层的远端能力注入点；未传入时默认装配 HTTP adapter。
 */
export function createQrCodeAuthRuntime(input: {
  service?: QrCodeAuthServicePort;
  fetch?: FetchLike;
  wait?: (ms: number) => Promise<void>;
} = {}): QrCodeAuth {
  const service = input.service ?? new HttpQrCodeAuthService(input.fetch);
  const wait = input.wait ?? defaultWait;

  return {
    async run(runInput: QrCodeAuthRunInput): Promise<void> {
      validateRunInput(runInput);
      const resolved = resolveAuthEnvironment(runInput.environment);
      const controller = new QrCodeAuthSessionController({
        service,
        baseUrl: resolved.baseUrl,
        channel: runInput.channel.trim(),
        mac: runInput.mac,
        policy: mergePolicy(runInput.policy),
        onSnapshot: runInput.onSnapshot,
        wait,
      });
      await controller.start();
    },
  };
}

function validateRunInput(input: QrCodeAuthRunInput): void {
  if (typeof input.onSnapshot !== "function") {
    throw new TypeError("QrCodeAuth.run() requires onSnapshot callback.");
  }

  if (!input.channel || !input.channel.trim()) {
    throw new TypeError("QrCodeAuth.run() requires non-empty channel.");
  }

  if (typeof input.mac !== "string") {
    throw new TypeError("QrCodeAuth.run() requires mac to be a string.");
  }
}

function mergePolicy(policy?: QrCodeAuthPolicy): Required<QrCodeAuthPolicy> {
  const refreshOnExpired = readRefreshOnExpired(policy);
  const maxRefreshCount = readNumericPolicy(policy?.maxRefreshCount, "maxRefreshCount");
  const pollIntervalMs = readNumericPolicy(policy?.pollIntervalMs, "pollIntervalMs");

  if (maxRefreshCount < 0) {
    throw new TypeError("QrCodeAuth.run() requires maxRefreshCount to be >= 0.");
  }
  if (pollIntervalMs <= 0) {
    throw new TypeError("QrCodeAuth.run() requires pollIntervalMs to be > 0.");
  }

  return {
    refreshOnExpired,
    maxRefreshCount: Math.floor(maxRefreshCount),
    pollIntervalMs: Math.floor(pollIntervalMs),
  };
}

function readRefreshOnExpired(policy?: QrCodeAuthPolicy): boolean {
  if (!policy || policy.refreshOnExpired === undefined) {
    return DEFAULT_POLICY.refreshOnExpired;
  }
  if (typeof policy.refreshOnExpired !== "boolean") {
    throw new TypeError("QrCodeAuth.run() requires refreshOnExpired to be a boolean.");
  }
  return policy.refreshOnExpired;
}

function readNumericPolicy(
  value: number | undefined,
  field: "maxRefreshCount" | "pollIntervalMs",
): number {
  if (value === undefined) {
    return DEFAULT_POLICY[field];
  }
  if (!Number.isFinite(value)) {
    throw new TypeError(`QrCodeAuth.run() requires ${field} to be a finite number.`);
  }
  return value;
}

async function defaultWait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
