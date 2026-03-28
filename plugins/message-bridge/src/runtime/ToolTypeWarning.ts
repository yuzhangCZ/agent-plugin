import { KNOWN_TOOL_TYPES, isKnownToolType } from '../contracts/transport-messages.js';
import type { BridgeLogger } from './AppLogger.js';

export function warnUnknownToolType(
  logger: BridgeLogger | undefined,
  message: string,
  toolType: string,
  extra: Record<string, unknown> = {},
): void {
  if (isKnownToolType(toolType)) {
    return;
  }

  logger?.warn(message, {
    toolType,
    knownToolTypes: [...KNOWN_TOOL_TYPES],
    ...extra,
  });
}
