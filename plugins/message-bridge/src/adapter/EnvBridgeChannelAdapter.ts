import { TOOL_TYPE_UNIASSISTANT } from '../contracts/transport-messages.js';
import type { BridgeChannelPort } from '../port/BridgeChannelPort.js';

export class EnvBridgeChannelAdapter implements BridgeChannelPort {
  constructor(private readonly channel = process.env.BRIDGE_CHANNEL?.trim()) {}

  getChannel(): string | undefined {
    return this.channel || undefined;
  }

  isAssiantChannel(): boolean {
    return this.getChannel() === TOOL_TYPE_UNIASSISTANT;
  }
}
