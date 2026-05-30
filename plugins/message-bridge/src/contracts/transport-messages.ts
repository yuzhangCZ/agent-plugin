export * from '../gateway-wire/transport.js';

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
