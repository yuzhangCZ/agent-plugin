import type { GatewayWireCodec } from './GatewayWireCodec.ts';
import type { ReconnectClock, ReconnectPolicy } from './ReconnectPolicy.ts';
import type { ReconnectScheduler } from './ReconnectScheduler.ts';

/**
 * 仅用于测试与集成注入的依赖覆写项。
 */
export interface GatewayClientOverrides {
  reconnectPolicy?: ReconnectPolicy;
  reconnectScheduler?: ReconnectScheduler;
  clock?: ReconnectClock;
  random?: () => number;
  wireCodec?: GatewayWireCodec;
  webSocketFactory?: (url: string, protocols?: string[]) => WebSocket;
}
