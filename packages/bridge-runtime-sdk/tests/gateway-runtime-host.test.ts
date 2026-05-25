import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeRuntime } from '../src/index.ts';
import type { BridgeGatewayHostConfig } from '../src/index.ts';
import {
  normalizeBridgeGatewayHostConfig,
  type BridgeGatewayHostConnection,
  type BridgeGatewayHostState,
} from '../src/infrastructure/gateway/gateway-host.ts';
import { resolvePackageVersion } from '../src/packageVersion.ts';

class HostGatewayClient extends EventEmitter implements BridgeGatewayHostConnection {
  sent: unknown[] = [];
  private state: BridgeGatewayHostState = 'DISCONNECTED';

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

  getState(): BridgeGatewayHostState {
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

function createGatewayConfig(): BridgeGatewayHostConfig {
  return {
    url: 'ws://gateway.local',
    auth: {
      ak: 'ak',
      sk: 'sk',
    },
    register: {
      toolType: 'openx',
      toolVersion: '0.0.0',
      pluginVersion: '0.1.0',
    },
  };
}

test('normalizeBridgeGatewayHostConfig auto injects sdkVersion while preserving pluginVersion', () => {
  const normalized = normalizeBridgeGatewayHostConfig(createGatewayConfig());

  assert.equal(normalized.register.sdkVersion, resolvePackageVersion());
  assert.equal(normalized.register.pluginVersion, '0.1.0');
});

test('normalizeBridgeGatewayHostConfig omits sdkVersion when sdk package version is unavailable', () => {
  const originalPackageVersion = globalThis.__MB_SDK_PACKAGE_VERSION__;
  delete globalThis.__MB_SDK_PACKAGE_VERSION__;

  try {
    const normalized = normalizeBridgeGatewayHostConfig(createGatewayConfig());
    assert.equal('sdkVersion' in normalized.register, false);
    assert.equal(normalized.register.pluginVersion, '0.1.0');
  } finally {
    if (typeof originalPackageVersion === 'undefined') {
      delete globalThis.__MB_SDK_PACKAGE_VERSION__;
    } else {
      globalThis.__MB_SDK_PACKAGE_VERSION__ = originalPackageVersion;
    }
  }
});

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
    gatewayHost: createGatewayConfig(),
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
