export const GATEWAY_CLIENT_STATE = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  READY: 'READY',
} as const;

export type GatewayClientState = (typeof GATEWAY_CLIENT_STATE)[keyof typeof GATEWAY_CLIENT_STATE];

/**
 * Gateway 连接状态的只读快照视图。
 * @remarks 该对象不持有独立状态，只包装某次读取到的状态值。
 */
export interface GatewayClientStatus {
  /** 返回当前快照是否已完成 register 握手。 */
  isReady(): boolean;
}

/**
 * 由状态值推导语义化只读视图，避免调用方散落 READY 字面量判断。
 */
export function createGatewayClientStatus(state: GatewayClientState): GatewayClientStatus {
  return {
    isReady: () => state === GATEWAY_CLIENT_STATE.READY,
  };
}
