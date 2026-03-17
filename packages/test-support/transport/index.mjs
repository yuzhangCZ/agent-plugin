import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';

export function createMessageRecorder() {
  const messages = [];
  return {
    messages,
    send(message) {
      messages.push(message);
    },
  };
}

export class MockGatewayServer {
  constructor(options = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.path = options.path ?? '/ws/agent';
    this.port = options.port ?? 0;
    this.httpServer = null;
    this.wsServer = null;
    this.sockets = new Set();
    this.receivedMessages = [];
    this.receivedToolErrors = [];
    this.connected = false;
    this.onMessage = options.onMessage ?? null;
  }

  async start() {
    this.httpServer = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('mock-gateway');
    });
    this.wsServer = new WebSocketServer({ server: this.httpServer, path: this.path });
    this.wsServer.on('connection', (socket) => {
      this.connected = true;
      this.sockets.add(socket);
      socket.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        this.receivedMessages.push({ ...parsed, timestamp: Date.now() });
        if (parsed?.type === 'tool_error') {
          this.receivedToolErrors.push(parsed);
        }
        this.onMessage?.(parsed, socket, this);
      });
      socket.on('close', () => {
        this.sockets.delete(socket);
        this.connected = this.sockets.size > 0;
      });
    });
    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.port, this.host, () => resolve());
    });
    const address = this.httpServer.address();
    this.port = typeof address === 'object' && address ? address.port : this.port;
    return { port: this.port, connected: this.connected };
  }

  async stop() {
    for (const socket of this.sockets) {
      socket.close();
    }
    this.sockets.clear();
    await new Promise((resolve) => {
      if (!this.wsServer) {
        resolve();
        return;
      }
      this.wsServer.close(() => resolve());
    });
    await new Promise((resolve) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close(() => resolve());
    });
    this.connected = false;
    return { stopped: true };
  }

  send(message) {
    const socket = this.getActiveSocket();
    socket.send(JSON.stringify(message));
    return { sent: true, message };
  }

  receive(message) {
    this.receivedMessages.push({ ...message, timestamp: Date.now() });
    if (message?.type === 'tool_error') {
      this.receivedToolErrors.push(message);
    }
    return { received: true };
  }

  sendInvoke(payload) {
    return this.send({
      type: 'invoke',
      welinkSessionId: payload.welinkSessionId || 'test-session',
      action: payload.action,
      payload: payload.payload,
      timestamp: Date.now(),
    });
  }

  sendStatusQuery() {
    return this.send({
      type: 'status_query',
      timestamp: Date.now(),
    });
  }

  async waitForConnection(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.sockets.size > 0) {
        return true;
      }
      await sleep(50);
    }
    return false;
  }

  async waitForMessage(predicate, timeoutMs = 10000, fromIndex = 0) {
    const start = Date.now();
    let seen = fromIndex;
    while (Date.now() - start < timeoutMs) {
      const next = this.receivedMessages.slice(seen).find(predicate);
      if (next) {
        return next;
      }
      seen = this.receivedMessages.length;
      await sleep(50);
    }
    return null;
  }

  getActiveSocket() {
    const socket = Array.from(this.sockets).at(-1);
    if (!socket) {
      throw new Error('No active gateway connection');
    }
    return socket;
  }

  recordToolError(message) {
    this.receivedToolErrors.push(message);
  }

  clear() {
    this.receivedMessages = [];
    this.receivedToolErrors = [];
  }

  setMessageHandler(handler) {
    this.onMessage = handler;
  }
}

export function createMockGateway(options = {}) {
  return new MockGatewayServer(options);
}
