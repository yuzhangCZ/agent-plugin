import { GATEWAY_CLIENT_STATE, type GatewayClientState } from '../../domain/state.ts';

export type BusinessMessageCommand =
  | { kind: 'emit-message'; message: unknown }
  | { kind: 'ignored-not-ready' };

/**
 * 业务消息 gating 处理器。
 * @remarks 仅产出领域决策，不直接触碰 transport、timer 或事件发射器。
 */
export class BusinessMessageHandler {
  handle(message: unknown, state: GatewayClientState): BusinessMessageCommand {
    // READY 前的业务帧只允许进入日志与 inbound 观测，不允许继续向上游 facade 透传成 message 事件。
    if (state !== GATEWAY_CLIENT_STATE.READY) {
      return { kind: 'ignored-not-ready' };
    }
    return { kind: 'emit-message', message };
  }
}
