export * from "../gateway-wire/transport.js";

export const KNOWN_CHANNELS = [
  "openclaw",
] as const;

export type KnownChannel = (typeof KNOWN_CHANNELS)[number];

export function isKnownChannel(value: string): value is KnownChannel {
  return KNOWN_CHANNELS.includes(value as KnownChannel);
}
