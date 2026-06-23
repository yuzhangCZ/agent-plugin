import type { GatewayTransport, GatewayTransportOpenOptions } from '../ports/GatewayTransport.ts';

/**
 * WebSocket transport 构造参数。
 */
export interface WebSocketGatewayTransportOptions {
  webSocketFactory?: (url: string, protocols?: string[]) => WebSocket;
}

/**
 * 基于浏览器 WebSocket 的 transport 适配实现。
 */
export class WebSocketGatewayTransport implements GatewayTransport {
  private readonly webSocketFactory?: (url: string, protocols?: string[]) => WebSocket;
  private socket: WebSocket | null = null;

  constructor(options: WebSocketGatewayTransportOptions = {}) {
    this.webSocketFactory = options.webSocketFactory;
  }

  open(options: GatewayTransportOpenOptions): void {
    let socket: WebSocket;
    if (this.webSocketFactory) {
      socket = this.webSocketFactory(options.url, options.protocols);
    } else if (options.protocols) {
      socket = new WebSocket(options.url, options.protocols);
    } else {
      socket = new WebSocket(options.url);
    }

    socket.onopen = options.onOpen;
    socket.onclose = options.onClose;
    socket.onerror = options.onError;
    socket.onmessage = options.onMessage as unknown as ((event: MessageEvent) => void);
    this.socket = socket;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  send(payload: string): void {
    this.socket?.send(payload);
  }

  isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }
}
