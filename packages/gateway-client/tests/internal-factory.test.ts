import test from 'node:test';
import assert from 'node:assert/strict';

import { createGatewayClientForTesting } from '../src/factory/createGatewayClientForTesting.ts';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: unknown[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  readonly url: string;
  readonly protocols?: string[];

  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'manual', wasClean: true });
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  emitMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

test('internal factory accepts overrides without leaking them through stable entry', async () => {
  FakeWebSocket.instances = [];
  const client = createGatewayClientForTesting(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: {
        type: 'register',
        deviceName: 'dev',
        os: 'darwin',
        toolType: 'opencode',
        toolVersion: '1.0.0',
      },
    },
    {
      webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
    },
  );

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  ws.emitMessage({ type: 'register_ok' });
  await connecting;

  assert.equal(ws.url, 'ws://localhost:8081/ws/agent');
  assert.deepEqual(ws.sent[0], {
    type: 'register',
    deviceName: 'dev',
    os: 'darwin',
    toolType: 'opencode',
    toolVersion: '1.0.0',
  });
  client.disconnect();
});
