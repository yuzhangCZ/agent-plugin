import { GATEWAY_CLIENT_STATE, type GatewayClientState } from '../../domain/state.ts';

export type BusinessMessageCommand =
  | { kind: 'emit-message'; message: unknown }
  | { kind: 'ignored-not-ready' };

// BusinessMessageHandler 只返回 READY gating 决策，不直接触碰 transport、timer 或事件发射器。
export class BusinessMessageHandler {
  handle(message: unknown, state: GatewayClientState): BusinessMessageCommand {
    if (state !== GATEWAY_CLIENT_STATE.READY) {
      return { kind: 'ignored-not-ready' };
    }
    return { kind: 'emit-message', message };
  }
}
