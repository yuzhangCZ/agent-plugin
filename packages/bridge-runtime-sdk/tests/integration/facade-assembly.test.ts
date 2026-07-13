import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { GatewayClientStatus } from '@agent-plugin/gateway-client';
import { qrcodeAuth as sourceQrCodeAuth } from '@wecode/skill-qrcode-auth';
import { createBridgeRuntime, qrcodeAuth } from '@/index.ts';
import type { BridgeGatewayHostConnection } from '@/infrastructure/gateway/gateway-host.ts';

class AssemblyGatewayClient extends EventEmitter implements BridgeGatewayHostConnection {
  private state: 'DISCONNECTED' | 'READY' = 'DISCONNECTED';

  async connect(): Promise<void> {
    this.state = 'READY';
    this.emit('statusChange', this.getStatus());
  }

  async disconnect(): Promise<void> {
    this.state = 'DISCONNECTED';
    this.emit('statusChange', this.getStatus());
  }

  send(): void {}

  isConnected(): boolean {
    return this.state === 'READY';
  }

  getStatus() {
    return this.state === 'READY'
      ? GatewayClientStatus.ready()
      : GatewayClientStatus.closed();
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
    gatewayHost: {
      url: 'ws://gateway.local',
      auth: {
        ak: 'ak',
        sk: 'sk',
      },
      register: {
        channel: 'openx',
        toolVersion: '0.0.0',
        pluginVersion: '0.1.0',
      },
    },
    connectionFactory: () => new AssemblyGatewayClient(),
    traceIdFactory: () => 'trace-1',
  });

  assert.equal(typeof runtime.start, 'function');
  assert.equal(typeof runtime.stop, 'function');
  assert.equal(typeof runtime.probe, 'function');
  assert.equal(typeof runtime.getStatus, 'function');
  assert.equal(typeof runtime.getDiagnostics, 'function');

  await assert.doesNotReject(runtime.start());
  await assert.doesNotReject(runtime.stop());
});

test('createBridgeRuntime does not create gateway connection during construction', async () => {
  let factoryCalls = 0;
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
    gatewayHost: {
      url: 'ws://gateway.local',
      auth: {
        ak: 'ak',
        sk: 'sk',
      },
      register: {
        channel: 'openx',
        toolVersion: '0.0.0',
        pluginVersion: '0.1.0',
      },
    },
    connectionFactory: () => {
      factoryCalls += 1;
      return new AssemblyGatewayClient();
    },
  });

  assert.equal(factoryCalls, 0);
  await runtime.start();
  assert.equal(factoryCalls, 1);
});

test('sdk root re-exports qrcode auth singleton facade', () => {
  assert.strictEqual(qrcodeAuth, sourceQrCodeAuth);
  assert.equal(typeof qrcodeAuth.run, 'function');
});
