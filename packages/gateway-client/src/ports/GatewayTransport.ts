export interface GatewayTransportOpenOptions {
  url: string;
  protocols?: string[];
  onOpen: (event?: unknown) => void;
  onClose: (event?: unknown) => void;
  onError: (event?: unknown) => void;
  onMessage: (event: { data: string | ArrayBuffer | Blob | Uint8Array }) => void;
}

// GatewayTransport 是 runtime 与具体 WebSocket 实现之间的边界，负责连接和原始帧收发。
export interface GatewayTransport {
  open(options: GatewayTransportOpenOptions): void;
  close(): void;
  send(payload: string): void;
  isOpen(): boolean;
}
