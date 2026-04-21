import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GatewayClient, GatewayClientConfig, GatewayClientState } from '@agent-plugin/gateway-client';

import { createBridgeRuntime } from '../src/index.ts';

class HostGatewayClient extends EventEmitter implements GatewayClient {
  sent: unknown[] = [];
  private state: GatewayClientState = 'DISCONNECTED';

  async connect(): Promise<void> {
    this.state = 'READY';
    this.emit('stateChange', this.state);
  }

  disconnect(): void {
    this.state = 'DISCONNECTED';
    this.emit('stateChange', this.state);
  }

  send(message: unknown): void {
    this.sent.push(message);
    this.emit('outbound', message);
  }

  isConnected(): boolean {
    return this.state === 'READY';
  }

  getState(): GatewayClientState {
    return this.state;
  }

  getStatus() {
    return {
      isReady: () => this.state === 'READY',
    };
  }

  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  emitMessage(message: unknown): void {
    this.emit('message', message);
  }

  emitInbound(frame: unknown): void {
    this.emit('inbound', frame);
  }
}

function createGatewayConfig(): GatewayClientConfig {
  return {
    url: 'ws://gateway.local',
    registerMessage: {
      type: 'register',
      mac: '00:00:00:00:00:00',
      os: 'darwin',
      toolType: 'openclaw',
      toolVersion: '0.0.0',
      deviceName: 'runtime-test',
    },
  };
}

test('host runtime records gateway diagnostics and processes downstream messages', async () => {
  const connection = new HostGatewayClient();
  const runtime = await createBridgeRuntime({
    provider: {
      async health() {
        return { online: true };
      },
      async createSession() {
        return { toolSessionId: 'tool-1' };
      },
      async runMessage() {
        return {
          runId: 'run-1',
          facts: (async function* () {})(),
          async result() {
            return { outcome: 'completed' as const };
          },
        };
      },
      async replyQuestion() {
        return { applied: true };
      },
      async replyPermission() {
        return { applied: true };
      },
      async closeSession() {
        return { applied: true };
      },
      async abortSession() {
        return { applied: true };
      },
    },
    gateway: createGatewayConfig(),
    connectionFactory: () => connection,
  });

  await runtime.start();
  connection.emitInbound({ kind: 'business', messageType: 'invoke', message: { type: 'status_query' } });
  connection.emitMessage({
    type: 'invoke',
    action: 'create_session',
    welinkSessionId: 'wl-1',
    payload: { title: 'demo' },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(connection.sent[0], {
    type: 'session_created',
    welinkSessionId: 'wl-1',
    toolSessionId: 'tool-1',
    session: {
      sessionId: 'tool-1',
    },
  });
  assert.equal(runtime.getDiagnostics().gatewayState, 'READY');
  assert.equal(typeof runtime.getDiagnostics().lastInboundAt, 'number');
});
