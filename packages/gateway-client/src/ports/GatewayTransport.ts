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
  open(options: GatewayTransportOpenOptions): void;
  close(): void;
  send(payload: string): void;
  isOpen(): boolean;
}
