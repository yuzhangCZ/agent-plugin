import type { GatewayTransport, GatewayTransportOpenOptions } from '../ports/GatewayTransport.ts';

export interface WebSocketGatewayTransportOptions {
  webSocketFactory?: (url: string, protocols?: string[]) => WebSocket;
}

export class WebSocketGatewayTransport implements GatewayTransport {
  private readonly webSocketFactory?: (url: string, protocols?: string[]) => WebSocket;
  private socket: WebSocket | null = null;

  constructor(options: WebSocketGatewayTransportOptions = {}) {
    this.webSocketFactory = options.webSocketFactory;
  }

  open(options: GatewayTransportOpenOptions): void {
    const socket = this.webSocketFactory
      ? this.webSocketFactory(options.url, options.protocols)
      : options.protocols
        ? new WebSocket(options.url, options.protocols)
        : new WebSocket(options.url);

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
