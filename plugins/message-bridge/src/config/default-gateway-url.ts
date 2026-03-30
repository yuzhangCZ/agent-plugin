const LOCALHOST_DEFAULT_GATEWAY_URL = "ws://localhost:8081/ws/agent";

function readInjectedDefaultGatewayUrl() {
  const candidate = (globalThis as typeof globalThis & { __MB_DEFAULT_GATEWAY_URL__?: unknown }).__MB_DEFAULT_GATEWAY_URL__;
  if (typeof candidate !== "string") {
    return null;
  }

  const normalized = candidate.trim();
  return normalized || null;
}

export const DEFAULT_GATEWAY_URL = readInjectedDefaultGatewayUrl() ?? LOCALHOST_DEFAULT_GATEWAY_URL;
