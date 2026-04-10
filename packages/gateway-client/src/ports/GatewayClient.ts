import type { GatewaySendContext } from '../domain/send-context.ts';
import type { GatewayClientState } from '../domain/state.ts';
import type { GatewaySendPayload } from './GatewayClientMessages.ts';
import type { GatewayClientEvents } from './GatewayClientEvents.ts';

/**
 * 插件侧应直接依赖的唯一 facade。
 * @remarks 内部 transport/runtime 日志由编排层统一产出，调用方只消费事件与错误。
 */
export interface GatewayClient {
  /** 建立连接并完成 register 握手。 */
  connect(): Promise<void>;
  /** 主动断开连接并停止重连与心跳。 */
  disconnect(): void;
  /** 统一发送出口；业务消息会执行 READY gating 与协议校验。 */
  send(message: GatewaySendPayload, logContext?: GatewaySendContext): void;
  /** 返回 transport 连接态。 */
  isConnected(): boolean;
  /** 返回状态机状态。 */
  getState(): GatewayClientState;
  /** 订阅 facade 事件。 */
  on<E extends keyof GatewayClientEvents>(event: E, listener: GatewayClientEvents[E]): this;
}
