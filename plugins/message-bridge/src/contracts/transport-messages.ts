export const CHANNEL_OPENCODE = 'opencode';
export const CHANNEL_OPENX = 'openx';
export const CHANNEL_UNIASSISTANT = 'uniassistant';
export const CHANNEL_CODEAGENT = 'codeagent';

export const KNOWN_CHANNELS = [
  CHANNEL_OPENCODE,
  CHANNEL_OPENX,
  CHANNEL_UNIASSISTANT,
  CHANNEL_CODEAGENT,
] as const;

export type KnownChannel = typeof KNOWN_CHANNELS[number];

export function isKnownChannel(value: string): value is KnownChannel {
  return KNOWN_CHANNELS.includes(value as KnownChannel);
}

export const TOOL_TYPE_OPENCODE = CHANNEL_OPENCODE;
export const TOOL_TYPE_OPENX = CHANNEL_OPENX;
export const TOOL_TYPE_UNIASSISTANT = CHANNEL_UNIASSISTANT;
export const TOOL_TYPE_CODEAGENT = CHANNEL_CODEAGENT;
export const KNOWN_TOOL_TYPES = KNOWN_CHANNELS;

export type KnownToolType = KnownChannel;

export function isKnownToolType(value: string): value is KnownToolType {
  return isKnownChannel(value);
}
