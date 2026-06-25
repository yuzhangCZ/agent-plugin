import type { GatewayClientStatus, GatewayInboundFrame } from '@agent-plugin/gateway-client';
import type { GatewayDownstreamBusinessRequest } from '@agent-plugin/gateway-schema';

import type { BridgeGatewayHostConnection } from '../../infrastructure/gateway/gateway-host.ts';

interface GatewayRuntimeObserverCallbacks {
  onStatusChange(status: GatewayClientStatus): void;
  onInbound(frame: GatewayInboundFrame): void;
  onOutbound(): void;
  onHeartbeat(): void;
  onMessage(message: GatewayDownstreamBusinessRequest): void;
}

/**
 * gateway runtime observer wiring。
 */
export function attachGatewayRuntimeObservers(
  client: BridgeGatewayHostConnection,
  callbacks: GatewayRuntimeObserverCallbacks,
): () => void {
  client.on('statusChange', callbacks.onStatusChange);
  client.on('inbound', callbacks.onInbound as (frame: unknown) => void);
  client.on('outbound', callbacks.onOutbound);
  client.on('heartbeat', callbacks.onHeartbeat);
  client.on('message', callbacks.onMessage as (message: unknown) => void);

  return () => {
    const eventEmitter = client as BridgeGatewayHostConnection & {
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const remove = eventEmitter.off?.bind(eventEmitter) ?? eventEmitter.removeListener?.bind(eventEmitter);
    if (!remove) {
      return;
    }
    remove('statusChange', callbacks.onStatusChange as (...args: unknown[]) => void);
    remove('inbound', callbacks.onInbound as (...args: unknown[]) => void);
    remove('outbound', callbacks.onOutbound as (...args: unknown[]) => void);
    remove('heartbeat', callbacks.onHeartbeat as (...args: unknown[]) => void);
    remove('message', callbacks.onMessage as (...args: unknown[]) => void);
  };
}
