import { CHANNEL_UNIASSISTANT } from '../contracts/transport-messages.js';
import type { BridgeChannelPort } from '../port/BridgeChannelPort.js';

export class EnvBridgeChannelAdapter implements BridgeChannelPort {
  private channel?: string;

  constructor(channel?: string) {
    this.setChannel(channel);
  }

  setChannel(channel?: string): void {
    const normalized = channel?.trim();
    this.channel = normalized || undefined;
  }

  getChannel(): string | undefined {
    return this.channel || undefined;
  }

  isAssiantChannel(): boolean {
    return this.getChannel() === CHANNEL_UNIASSISTANT;
  }
}
