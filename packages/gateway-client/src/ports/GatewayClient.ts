import type { GatewaySendContext } from '../domain/send-context.ts';
import type { GatewayClientState } from '../domain/state.ts';
import type { GatewaySendPayload } from './GatewayClientMessages.ts';
import type { GatewayClientEvents } from './GatewayClientEvents.ts';

export interface GatewayClient {
  connect(): Promise<void>;
  disconnect(): void;
  send(message: GatewaySendPayload, logContext?: GatewaySendContext): void;
  isConnected(): boolean;
  getState(): GatewayClientState;
  on<E extends keyof GatewayClientEvents>(event: E, listener: GatewayClientEvents[E]): this;
}
