export * from "../gateway-wire/transport.js";

export const KNOWN_TOOL_TYPES = [
  "openx",
] as const;

export type KnownToolType = (typeof KNOWN_TOOL_TYPES)[number];

export function isKnownToolType(value: string): value is KnownToolType {
  return KNOWN_TOOL_TYPES.includes(value as KnownToolType);
}
