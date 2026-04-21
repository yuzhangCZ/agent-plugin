import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import type { GatewayClient, GatewayClientState } from '@agent-plugin/gateway-client';

import { createBridgeRuntime } from '../src/index.ts';

class AssemblyGatewayClient extends EventEmitter implements GatewayClient {
  private state: GatewayClientState = 'DISCONNECTED';

  async connect(): Promise<void> {
    this.state = 'READY';
    this.emit('stateChange', this.state);
  }

  disconnect(): void {
    this.state = 'DISCONNECTED';
    this.emit('stateChange', this.state);
  }

  send(): void {}

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
}

test('createBridgeRuntime assembles a host runtime facade', async () => {
  const runtime = await createBridgeRuntime({
    provider: {
      async health() {
        return { online: true };
      },
      async createSession() {
        return { toolSessionId: 'tool-session-1' };
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
    gateway: {
      url: 'ws://gateway.local',
      registerMessage: {
        type: 'register',
        mac: '00:00:00:00:00:00',
        os: 'darwin',
        toolType: 'openclaw',
        toolVersion: '0.0.0',
        deviceName: 'runtime-test',
      },
    },
    connectionFactory: () => new AssemblyGatewayClient(),
    traceIdFactory: () => 'trace-1',
  });

  assert.equal(typeof runtime.start, 'function');
  assert.equal(typeof runtime.stop, 'function');
  assert.equal(typeof runtime.getStatus, 'function');
  assert.equal(typeof runtime.getDiagnostics, 'function');

  await assert.doesNotReject(runtime.start());
  await assert.doesNotReject(runtime.stop());
});
