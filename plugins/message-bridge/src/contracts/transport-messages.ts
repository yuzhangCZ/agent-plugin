export * from '../gateway-wire/transport.js';

export const TOOL_TYPE_OPENX = 'openx';
export const TOOL_TYPE_UNIASSISTANT = 'uniassistant';
export const TOOL_TYPE_CODEAGENT = 'codeagent';

export const KNOWN_TOOL_TYPES = [
  TOOL_TYPE_OPENX,
  TOOL_TYPE_UNIASSISTANT,
  TOOL_TYPE_CODEAGENT,
] as const;

export type KnownToolType = typeof KNOWN_TOOL_TYPES[number];

export function isKnownToolType(value: string): value is KnownToolType {
  return KNOWN_TOOL_TYPES.includes(value as KnownToolType);
}
