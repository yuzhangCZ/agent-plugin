/**
 * transport 打开连接时需要的回调与连接参数。
 */
export interface GatewayTransportOpenOptions {
  url: string;
  protocols?: string[];
  onOpen: (event?: unknown) => void;
  onClose: (event?: unknown) => void;
  onError: (event?: unknown) => void;
  onMessage: (event: { data: string | ArrayBuffer | Blob | Uint8Array }) => void;
}

/**
 * runtime 与具体 WebSocket 实现之间的边界。
 * @remarks 该接口仅承担连接与原始帧收发职责。
 */
export interface GatewayTransport {
  /** 打开底层连接并绑定回调。 */
  open(options: GatewayTransportOpenOptions): void;
  /** 关闭底层连接。 */
  close(): void;
  /** 发送已序列化字符串帧。 */
  send(payload: string): void;
  /** 判断底层连接是否处于 open 状态。 */
  isOpen(): boolean;
}
