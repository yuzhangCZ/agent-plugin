import { KNOWN_CHANNELS, isKnownChannel } from '../contracts/transport-messages.js';
import type { BridgeLogger } from './AppLogger.js';

export function warnUnknownChannel(
  logger: BridgeLogger | undefined,
  message: string,
  channel: string,
  extra: Record<string, unknown> = {},
): void {
  if (isKnownChannel(channel)) {
    return;
  }

  logger?.warn(message, {
    channel,
    knownChannels: [...KNOWN_CHANNELS],
    ...extra,
  });
}
