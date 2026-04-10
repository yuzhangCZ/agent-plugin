import type { GatewaySendContext } from '../domain/send-context.ts';
import type { GatewayClientState } from '../domain/state.ts';
import type { GatewaySendPayload } from './GatewayClientMessages.ts';
import type { GatewayClientEvents } from './GatewayClientEvents.ts';

/**
 * 插件侧应直接依赖的唯一 facade。
 * @remarks 内部 transport/runtime 日志由编排层统一产出，调用方只消费事件与错误。
 */
export interface GatewayClient {
  connect(): Promise<void>;
  disconnect(): void;
  send(message: GatewaySendPayload, logContext?: GatewaySendContext): void;
  isConnected(): boolean;
  getState(): GatewayClientState;
  on<E extends keyof GatewayClientEvents>(event: E, listener: GatewayClientEvents[E]): this;
}
