import type { GatewayWireCodec } from './GatewayWireCodec.ts';
import type { ReconnectClock, ReconnectPolicy } from './ReconnectPolicy.ts';
import type { ReconnectScheduler } from './ReconnectScheduler.ts';

export interface GatewayClientOverrides {
  reconnectPolicy?: ReconnectPolicy;
  reconnectScheduler?: ReconnectScheduler;
  clock?: ReconnectClock;
  random?: () => number;
  wireCodec?: GatewayWireCodec;
  webSocketFactory?: (url: string, protocols?: string[]) => WebSocket;
}
