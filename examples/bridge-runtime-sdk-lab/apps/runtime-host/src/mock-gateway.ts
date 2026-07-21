import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { WebSocketServer, type WebSocket } from 'ws';

import { EventStore } from './event-store.ts';

export class LabMockGateway {
  readonly #events: EventStore;
  readonly #sockets = new Set<WebSocket>();
  readonly receivedMessages: unknown[] = [];
  #httpServer: http.Server | undefined;
  #wsServer: WebSocketServer | undefined;
  #port = 0;

  constructor(events: EventStore) {
    this.#events = events;
  }

  get url(): string | undefined {
    if (!this.#port) {
      return undefined;
    }
    return `ws://127.0.0.1:${this.#port}/ws/agent`;
  }

  get connected(): boolean {
    return this.#sockets.size > 0;
  }

  async start(): Promise<{ url: string }> {
    if (this.url) {
      return { url: this.url };
    }

    this.#httpServer = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('bridge-runtime-sdk-lab-mock-gateway');
    });
    this.#wsServer = new WebSocketServer({ server: this.#httpServer, path: '/ws/agent' });
    this.#wsServer.on('connection', (socket) => {
      this.#sockets.add(socket);
      this.#events.append('mock_gateway.connected', 'SDK connected to mock gateway');
      socket.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as unknown;
        this.receivedMessages.push(parsed);
        this.#events.append('mock_gateway.uplink', 'Mock gateway captured uplink', { message: parsed });
        if (isRecord(parsed) && parsed.type === 'register') {
          socket.send(JSON.stringify({ type: 'register_ok' }));
          this.#events.append('mock_gateway.register_ok', 'Mock gateway accepted register');
        }
      });
      socket.on('close', () => {
        this.#sockets.delete(socket);
        this.#events.append('mock_gateway.disconnected', 'SDK disconnected from mock gateway');
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.#httpServer?.once('error', reject);
      this.#httpServer?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.#httpServer.address();
    if (typeof address !== 'object' || !address) {
      throw new Error('mock gateway address unavailable');
    }
    this.#port = address.port;
    this.#events.append('mock_gateway.started', 'Mock gateway started', { url: this.url });
    return { url: this.url! };
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.close();
    }
    this.#sockets.clear();
    await new Promise<void>((resolve) => {
      this.#wsServer?.close(() => resolve());
      if (!this.#wsServer) {
        resolve();
      }
    });
    await new Promise<void>((resolve) => {
      this.#httpServer?.close(() => resolve());
      if (!this.#httpServer) {
        resolve();
      }
    });
    this.#wsServer = undefined;
    this.#httpServer = undefined;
    this.#port = 0;
    this.#events.append('mock_gateway.stopped', 'Mock gateway stopped');
  }

  clear(): void {
    this.receivedMessages.length = 0;
  }

  send(raw: unknown): void {
    const socket = Array.from(this.#sockets).at(-1);
    if (!socket) {
      throw new Error('Mock gateway has no active SDK connection');
    }
    socket.send(JSON.stringify(raw));
    this.#events.append('mock_gateway.downstream', 'Mock gateway sent downstream', { raw });
  }

  async waitForMessages(fromIndex: number, timeoutMs = 1200): Promise<unknown[]> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.receivedMessages.length > fromIndex) {
        await sleep(50);
        return this.receivedMessages.slice(fromIndex);
      }
      await sleep(50);
    }
    return this.receivedMessages.slice(fromIndex);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
