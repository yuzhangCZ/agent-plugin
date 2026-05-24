import type { GatewayInboundFrame } from '@agent-plugin/gateway-client';
import type { GatewayDownstreamBusinessRequest } from '@agent-plugin/gateway-schema';

import type {
  BridgeGatewayHostConnection,
  BridgeGatewayHostError,
  BridgeGatewayHostState,
} from '../../infrastructure/gateway/gateway-host.ts';

interface GatewayRuntimeObserverCallbacks {
  onStateChange(state: BridgeGatewayHostState): void;
  onInbound(frame: GatewayInboundFrame): void;
  onOutbound(): void;
  onHeartbeat(): void;
  onMessage(message: GatewayDownstreamBusinessRequest): void;
  onError(error: BridgeGatewayHostError): void;
}

/**
 * gateway runtime observer wiring。
 */
export function attachGatewayRuntimeObservers(
  client: BridgeGatewayHostConnection,
  callbacks: GatewayRuntimeObserverCallbacks,
): () => void {
  client.on('stateChange', callbacks.onStateChange);
  client.on('inbound', callbacks.onInbound as (frame: unknown) => void);
  client.on('outbound', callbacks.onOutbound);
  client.on('heartbeat', callbacks.onHeartbeat);
  client.on('message', callbacks.onMessage as (message: unknown) => void);
  client.on('error', callbacks.onError);

  return () => {
    const eventEmitter = client as BridgeGatewayHostConnection & {
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const remove = eventEmitter.off?.bind(eventEmitter) ?? eventEmitter.removeListener?.bind(eventEmitter);
    if (!remove) {
      return;
    }
    remove('stateChange', callbacks.onStateChange as (...args: unknown[]) => void);
    remove('inbound', callbacks.onInbound as (...args: unknown[]) => void);
    remove('outbound', callbacks.onOutbound as (...args: unknown[]) => void);
    remove('heartbeat', callbacks.onHeartbeat as (...args: unknown[]) => void);
    remove('message', callbacks.onMessage as (...args: unknown[]) => void);
    remove('error', callbacks.onError as (...args: unknown[]) => void);
  };
}
