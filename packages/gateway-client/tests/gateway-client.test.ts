import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  createAkSkAuthProvider,
  createGatewayClient,
  GatewayClientError,
  GatewayClientUnknownError,
  type GatewayClientStatus,
  mapGatewayClientAvailability,
} from '../src/index.ts';
import { DefaultOutboundProtocolGate } from '../src/application/protocol/OutboundProtocolGate.ts';
import type { GatewayWireCodec } from '../src/ports/GatewayWireCodec.ts';
import { GatewayClientRuntime, type GatewayClientRuntimeDependencies } from '../src/application/GatewayClientRuntime.ts';
import { BusinessMessageHandler } from '../src/application/handlers/BusinessMessageHandler.ts';
import { GatewaySchemaCodecAdapter } from '../src/adapters/GatewaySchemaCodecAdapter.ts';
import { DefaultReconnectPolicy } from '../src/adapters/DefaultReconnectPolicy.ts';
import {
  DEFAULT_GATEWAY_RECONNECT_MAX_ELAPSED_MS,
  createGatewayRuntimeDependencies,
} from '../src/factory/createGatewayRuntimeDependencies.ts';

function statusKind(status: GatewayClientStatus): string {
  if (status.isReady()) {
    return 'ready';
  }
  if (status.isReconnecting()) {
    return 'reconnecting';
  }
  if (status.isConnecting()) {
    return 'connecting';
  }
  return 'closed';
}

function assertClosedWithError(status: GatewayClientStatus, code: GatewayClientError['code']): void {
  assert.equal(status.isClosed(), true);
  assert.equal(status.hasError(), true);
  assert.equal(status.getError()?.code, code);
}

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: unknown[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
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
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: 'manual', wasClean: true });
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  emitMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  emitRawMessage(data: string): void {
    this.onmessage?.({ data });
  }

  emitBinaryMessage(data: ArrayBuffer): void {
    this.onmessage?.({ data });
  }

  emitClose(event: { code: number; reason: string; wasClean: boolean }): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(event);
  }
}

function registerMessage() {
  return {
    type: 'register',
    deviceName: 'dev',
    os: 'darwin',
    toolType: 'opencode',
    toolVersion: '1.0.0',
    pluginVersion: '0.2.0',
  } as const;
}

async function flushAsyncHandlers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function assertPromisePending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flushAsyncHandlers();
  assert.equal(settled, false);
}

test('auth provider generates gateway-compatible payload and websocket auth subprotocol', async () => {
  FakeWebSocket.instances = [];
  const provider = createAkSkAuthProvider('ak-1', 'sk-1');
  const payload = provider.generateAuthPayload();

  assert.equal(payload.ak, 'ak-1');
  assert.match(payload.ts, /^\d{10}$/);
  assert.equal(
    payload.sign,
    createHmac('sha256', 'sk-1').update(`${payload.ak}${payload.ts}${payload.nonce}`).digest('base64'),
  );

  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    authPayloadProvider: () => payload,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  ws.emitMessage({ type: 'register_ok' });
  await connecting;

  assert.ok(ws.protocols?.[0]?.startsWith('auth.'));
  const decoded = JSON.parse(Buffer.from(ws.protocols![0]!.slice('auth.'.length), 'base64url').toString('utf8'));
  assert.deepEqual(decoded, payload);
  client.disconnect();
});

class FakeClock {
  nowMs: number;

  constructor(nowMs = 0) {
    this.nowMs = nowMs;
  }

  now(): number {
    return this.nowMs;
  }
}

class FakeReconnectScheduler {
  scheduled: Array<{ delayMs: number; task: () => Promise<void> | void }> = [];
  cancelCount = 0;

  schedule(task: () => Promise<void> | void, delayMs: number): void {
    this.scheduled.push({ task, delayMs });
  }

  cancel(): void {
    this.cancelCount += 1;
  }
}

class FakeHeartbeatScheduler {
  startCount = 0;
  stopCount = 0;
  private task?: () => void;

  start(task?: () => void): void {
    this.startCount += 1;
    if (task) {
      this.task = task;
    }
  }

  stop(): void {
    this.stopCount += 1;
  }

  trigger(): void {
    this.task?.();
  }
}

function createFakeSink() {
  return {
    emitStatusChange() {},
    emitInbound() {},
    emitOutbound() {},
    emitHeartbeat() {},
    emitMessage() {},
  };
}

function buildFakeDependencies(overrides: Partial<GatewayClientRuntimeDependencies> = {}): GatewayClientRuntimeDependencies {
  const wireCodec = overrides.wireCodec ?? new GatewaySchemaCodecAdapter();
  return {
    transport: overrides.transport ?? new FakeTransport(),
    heartbeatScheduler: overrides.heartbeatScheduler ?? new FakeHeartbeatScheduler(),
    reconnectScheduler: overrides.reconnectScheduler ?? new FakeReconnectScheduler(),
    reconnectEnabled: overrides.reconnectEnabled ?? true,
    reconnectPolicy: overrides.reconnectPolicy ?? new FakeReconnectPolicy(),
    wireCodec,
    outboundProtocolGate: overrides.outboundProtocolGate ?? new DefaultOutboundProtocolGate(wireCodec),
    businessMessageHandler: overrides.businessMessageHandler ?? new BusinessMessageHandler(),
    authSubprotocolBuilder: overrides.authSubprotocolBuilder ?? (() => 'auth.test'),
  };
}

class FakeReconnectPolicy {
  startWindow(): void {}
  reset(): void {}
  recordSuspendedDuration(): void {}
  scheduleNextAttempt() {
    return {
      ok: true as const,
      attempt: 1,
      delayMs: 250,
      elapsedMs: 0,
    };
  }
  getExhaustedDecision() {
    return null;
  }
}

class FakeTransport {
  private openState = false;
  private handlers?: {
    onOpen: (event?: unknown) => void;
    onClose: (event?: unknown) => void;
    onError: (event?: unknown) => void;
    onMessage: (event: { data: string | ArrayBuffer | Blob | Uint8Array }) => void;
  };
  sent: string[] = [];

  open(options: {
    onOpen: (event?: unknown) => void;
    onClose: (event?: unknown) => void;
    onError: (event?: unknown) => void;
    onMessage: (event: { data: string | ArrayBuffer | Blob | Uint8Array }) => void;
  }): void {
    this.handlers = options;
  }

  close(): void {
    this.openState = false;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  isOpen(): boolean {
    return this.openState;
  }

  emitOpen(): void {
    this.openState = true;
    this.handlers?.onOpen({});
  }

  emitMessage(message: unknown): void {
    this.handlers?.onMessage({ data: JSON.stringify(message) });
  }

  // 测试夹具遵循 runtime 契约：终态由 onClose 收口，可注入非标准 close code 验证 fail-closed。
  emitClose(event: { code?: unknown; reason?: unknown; wasClean?: unknown }): void {
    this.openState = false;
    this.handlers?.onClose(event);
  }

  emitError(event?: unknown): void {
    this.handlers?.onError(event);
  }
}

function installFakeTimeouts() {
  const scheduled: Array<{ id: number; delay: number; run: () => void }> = [];
  const cancelled = new Set<number>();
  let seq = 0;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  globalThis.setTimeout = ((callback, delay, ...args) => {
    const id = ++seq;
    scheduled.push({
      id,
      delay,
      run: () => callback(...args),
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id) => {
    cancelled.add(id as unknown as number);
  }) as typeof globalThis.clearTimeout;

  return {
    scheduled,
    cancelled,
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
    runNext() {
      const next = scheduled.shift();
      if (!next) {
        return false;
      }
      if (!cancelled.has(next.id)) {
        next.run();
      }
      return true;
    },
    runNextActive() {
      while (scheduled.length > 0) {
        const next = scheduled.shift()!;
        if (cancelled.has(next.id)) {
          continue;
        }
        next.run();
        return true;
      }
      return false;
    },
  };
}

test('connect sends register and enters READY only after register_ok', async () => {
  FakeWebSocket.instances = [];
  const statuses: GatewayClientStatus[] = [];
  const inbound: unknown[] = [];
  const outbound: unknown[] = [];
  const messages: unknown[] = [];
  const infoLogs: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    logger: {
      info(message, meta) {
        infoLogs.push({ message, meta });
      },
    },
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('statusChange', (status) => statuses.push(status));
  client.on('inbound', (message) => inbound.push(message));
  client.on('outbound', (message) => outbound.push(message));
  client.on('message', (message) => messages.push(message));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await assertPromisePending(connecting);

  assert.equal(client.getStatus().isConnecting(), true);
  assert.deepEqual(ws.sent[0], registerMessage());
  assert.deepEqual(outbound[0], registerMessage());
  assert.deepEqual(
    infoLogs.find((entry) => entry.message === 'gateway.register.sent')?.meta,
    {
      toolType: 'opencode',
      toolVersion: '1.0.0',
      sdkVersion: undefined,
      pluginVersion: '0.2.0',
    },
  );

  ws.emitMessage({ type: 'status_query' });
  await flushAsyncHandlers();
  assert.equal(messages.length, 0);

  ws.emitMessage({ type: 'register_ok' });
  await connecting;
  await flushAsyncHandlers();
  assert.equal(client.getStatus().isReady(), true);
  assert.deepEqual(inbound.at(-1), {
    kind: 'control',
    messageType: 'register_ok',
    message: { type: 'register_ok' },
  });
  assert.deepEqual(statuses.map(statusKind), ['connecting', 'ready']);

  ws.emitMessage({ type: 'status_query' });
  await flushAsyncHandlers();
  assert.deepEqual(messages[0], { type: 'status_query' });
  assert.deepEqual(inbound.at(-1), {
    kind: 'business',
    messageType: 'status_query',
    message: { type: 'status_query' },
  });

  await client.disconnect();
});

test('connect and disconnect emit stable status transitions and cancelled close error', async () => {
  FakeWebSocket.instances = [];
  const statuses: GatewayClientStatus[] = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('statusChange', (status) => statuses.push(status));

  assert.equal(client.getStatus().isClosed(), true);
  assert.equal(client.getStatus().hasError(), false);

  const connecting = client.connect();
  assert.equal(client.getStatus().isConnecting(), true);

  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await assertPromisePending(connecting);
  assert.equal(client.getStatus().isConnecting(), true);

  ws.emitMessage({ type: 'register_ok' });
  await connecting;
  await flushAsyncHandlers();
  assert.equal(client.getStatus().isReady(), true);

  await client.disconnect();
  const closed = client.getStatus();
  assert.equal(closed.isClosed(), true);
  assert.equal(closed.isCancelled(), true);
  assert.equal(closed.isFailureClosed(), false);
  assert.equal(closed.getError()?.code, 'GATEWAY_CLOSED_MANUAL');
  assert.equal(closed.getError()?.disposition, 'cancelled');
  assert.equal(closed.getError()?.retryable, false);
  assert.deepEqual(statuses.map(statusKind), ['connecting', 'ready', 'closed']);
});

test('connect reuses the same in-flight attempt until handshake completes', async () => {
  FakeWebSocket.instances = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  const first = client.connect();
  const second = client.connect();

  assert.equal(FakeWebSocket.instances.length, 1);

  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await assertPromisePending(first);

  const third = client.connect();

  ws.emitMessage({ type: 'register_ok' });
  await first;
  await second;
  await third;
  assert.equal(client.getStatus().isReady(), true);

  client.disconnect();
});

test('connect resolves immediately when the client is already READY', async () => {
  FakeWebSocket.instances = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  ws.emitMessage({ type: 'register_ok' });
  await connecting;

  await client.connect();
  assert.equal(FakeWebSocket.instances.length, 1);

  client.disconnect();
});

test('non-json inbound text emits parse_error frame', async () => {
  FakeWebSocket.instances = [];
  const inbound: unknown[] = [];

  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('inbound', (message) => inbound.push(message));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  ws.emitMessage({ type: 'register_ok' });
  await connecting;

  ws.emitRawMessage('{"bad":');
  await flushAsyncHandlers();

  assert.deepEqual(inbound.at(-1), {
    kind: 'parse_error',
    rawPreview: '{"bad":',
  });

  client.disconnect();
});

test('binary inbound frame emits decode_error frame', async () => {
  FakeWebSocket.instances = [];
  const inbound: unknown[] = [];

  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('inbound', (message) => inbound.push(message));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  ws.emitMessage({ type: 'register_ok' });
  await connecting;

  const payload = new TextEncoder().encode('{"type":"status_query"}').buffer;
  ws.emitBinaryMessage(payload);
  await flushAsyncHandlers();

  assert.deepEqual(inbound.at(-1), {
    kind: 'decode_error',
    reason: 'unsupported_binary_frame',
  });

  client.disconnect();
});

test('invalid downstream inbound frame is not emitted as business', async () => {
  FakeWebSocket.instances = [];
  const inbound: unknown[] = [];
  const messages: unknown[] = [];
  const logs = {
    error: [] as Array<{ message: string; meta?: Record<string, unknown> }>,
  };

  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    logger: {
      error(message, meta) {
        logs.error.push({ message, meta });
      },
    },
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('inbound', (message) => inbound.push(message));
  client.on('message', (message) => messages.push(message));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  ws.emitMessage({ type: 'register_ok' });
  await connecting;
  await flushAsyncHandlers();

  ws.emitMessage({
    type: 'invoke',
    messageId: 'gw-invalid-1',
    welinkSessionId: 'wl-invalid-1',
    action: 'chat',
    payload: {
      toolSessionId: 'tool-1',
    },
  });
  await flushAsyncHandlers();

  const lastInbound = inbound.at(-1) as {
    kind?: string;
    messageType?: string;
    gatewayMessageId?: string;
    welinkSessionId?: string;
    toolSessionId?: string;
    action?: string;
    rawPreview?: unknown;
  } | undefined;
  assert.equal(lastInbound?.kind, 'invalid');
  assert.equal(lastInbound?.messageType, 'invoke');
  assert.equal(lastInbound?.gatewayMessageId, 'gw-invalid-1');
  assert.equal(lastInbound?.welinkSessionId, 'wl-invalid-1');
  assert.equal(lastInbound?.toolSessionId, 'tool-1');
  assert.equal(lastInbound?.action, 'chat');
  assert.deepEqual(lastInbound?.rawPreview, {
    type: 'invoke',
    messageId: 'gw-invalid-1',
    welinkSessionId: 'wl-invalid-1',
    action: 'chat',
    payload: {
      toolSessionId: 'tool-1',
    },
  });
  assert.equal(messages.length, 0);
  assert.equal(logs.error[0]?.message, 'gateway.business.validation_failed');
  assert.equal(logs.error[0]?.meta?.failClosed, false);
  assert.equal(logs.error[0]?.meta?.gatewayMessageId, 'gw-invalid-1');
  assert.equal(
    logs.error[0]?.meta?.messagePreview,
    JSON.stringify({ type: 'invoke', keys: ['type', 'messageId', 'welinkSessionId', 'action', 'payload'] }),
  );
  assert.equal('rawPreview' in (logs.error[0]?.meta ?? {}), false);
  assert.equal(client.getStatus().isReady(), true);

  await client.disconnect();
});

test('invalid control frame emits protocol error instead of being silently ignored', async () => {
  FakeWebSocket.instances = [];
  const inbound: unknown[] = [];
  const logs = {
    error: [] as Array<{ message: string; meta?: Record<string, unknown> }>,
  };
  const fallbackCodec = new GatewaySchemaCodecAdapter();

  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    logger: {
      error(message, meta) {
        logs.error.push({ message, meta });
      },
    },
    wireCodec: {
      normalizeDownstream(raw) {
        return fallbackCodec.normalizeDownstream(raw);
      },
      validateGatewayUplinkBusinessMessage(raw) {
        return fallbackCodec.validateGatewayUplinkBusinessMessage(raw);
      },
      validateGatewayUpstreamTransportMessage(raw) {
        if (
          raw &&
          typeof raw === 'object' &&
          'type' in raw &&
          (raw as { type?: unknown }).type === 'register_rejected'
        ) {
          return {
            ok: false as const,
            error: {
              violation: {
                stage: 'transport',
                code: 'invalid_payload',
                field: 'reason',
                message: 'register_rejected reason is invalid',
                messageType: 'register_rejected',
              },
            },
          };
        }
        return fallbackCodec.validateGatewayUpstreamTransportMessage(raw);
      },
      validateGatewayWireProtocolMessage(raw) {
        return fallbackCodec.validateGatewayWireProtocolMessage(raw);
      },
    },
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('inbound', (message) => inbound.push(message));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  ws.emitMessage({ type: 'register_rejected', reason: 'bad-aksk' });
  let rejection: GatewayClientError | undefined;
  await assert.rejects(connecting, (error) => {
    rejection = error as GatewayClientError;
    return error instanceof GatewayClientError;
  });
  await flushAsyncHandlers();

  assert.equal(rejection?.code, 'GATEWAY_HANDSHAKE_INVALID');
  assert.equal(rejection?.disposition, 'startup_failure');
  assert.equal(rejection?.retryable, false);
  assert.equal(rejection?.details?.code, 'invalid_payload');
  assert.equal(rejection?.details?.field, 'reason');
  assert.equal(rejection?.details?.messageType, 'register_rejected');
  assert.equal(rejection?.details?.gatewayMessageId, undefined);
  assert.equal(
    rejection?.details?.messagePreview,
    JSON.stringify({ type: 'register_rejected', keys: ['type', 'reason'] }),
  );
  assert.equal('rawPreview' in (rejection?.details ?? {}), false);
  assert.equal(logs.error[0]?.message, 'gateway.control.validation_failed');
  assert.equal(
    logs.error[0]?.meta?.messagePreview,
    JSON.stringify({ type: 'register_rejected', keys: ['type', 'reason'] }),
  );
  assert.equal('rawPreview' in (logs.error[0]?.meta ?? {}), false);
  assert.equal(client.getStatus().isClosed(), true);
  assert.equal((inbound.at(-1) as { kind?: string })?.kind, 'invalid');
  assert.equal((inbound.at(-1) as { messageType?: string })?.messageType, 'register_rejected');
  assert.deepEqual((inbound.at(-1) as { rawPreview?: unknown })?.rawPreview, {
    type: 'register_rejected',
    reason: 'bad-aksk',
  });

  client.disconnect();
});

test('business inbound frame preserves rawPayload while business message stays on typed contract', async () => {
  FakeWebSocket.instances = [];
  const messages: Array<Record<string, unknown>> = [];
  const inbound: unknown[] = [];

  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('message', (message) => messages.push(message as Record<string, unknown>));
  client.on('inbound', (message) => inbound.push(message));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  ws.emitMessage({ type: 'register_ok' });
  await connecting;
  await flushAsyncHandlers();

  ws.emitMessage({
    type: 'invoke',
    action: 'create_session',
    welinkSessionId: 'wl_legacy',
    payload: {
      sessionId: 'session-123',
      metadata: { title: 'hello' },
    },
  });
  await flushAsyncHandlers();

  assert.deepEqual(messages.at(-1), {
    type: 'invoke',
    action: 'create_session',
    welinkSessionId: 'wl_legacy',
    payload: {},
  });
  assert.deepEqual(inbound.at(-1), {
    kind: 'business',
    messageType: 'invoke',
    message: {
      type: 'invoke',
      action: 'create_session',
      welinkSessionId: 'wl_legacy',
      payload: {},
    },
    rawPayload: {
      sessionId: 'session-123',
      metadata: { title: 'hello' },
    },
  });

  client.disconnect();
});

test('getStatus derives readiness from the current state snapshot', async () => {
  FakeWebSocket.instances = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  assert.equal(client.getStatus().isClosed(), true);
  assert.equal(client.getStatus().hasError(), false);
  assert.equal(client.getStatus().isReady(), false);

  const connecting = client.connect();
  assert.equal(client.getStatus().isConnecting(), true);
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  assert.equal(client.getStatus().isReady(), false);
  assert.equal(client.getStatus().isConnecting(), true);

  ws.emitMessage({ type: 'register_ok' });
  await connecting;
  await flushAsyncHandlers();

  assert.equal(client.getStatus().isReady(), true);

  await client.disconnect();
  assert.equal(client.getStatus().isReady(), false);
  assert.equal(client.getStatus().isClosed(), true);
  assertClosedWithError(client.getStatus(), 'GATEWAY_CLOSED_MANUAL');
  assert.equal(client.getStatus().isCancelled(), true);
});

test('default reconnect preset excludes delayed timer drift from maxElapsedMs budget', async () => {
  FakeWebSocket.instances = [];
  const logs = {
    debug: [] as Array<{ message: string; meta?: Record<string, unknown> }>,
    info: [] as Array<{ message: string; meta?: Record<string, unknown> }>,
    warn: [] as Array<{ message: string; meta?: Record<string, unknown> }>,
    error: [] as Array<{ message: string; meta?: Record<string, unknown> }>,
  };
  const clock = new FakeClock(0);
  const timers = installFakeTimeouts();
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    clock,
    logger: {
      debug(message, meta) {
        logs.debug.push({ message, meta });
      },
      info(message, meta) {
        logs.info.push({ message, meta });
      },
      warn(message, meta) {
        logs.warn.push({ message, meta });
      },
      error(message, meta) {
        logs.error.push({ message, meta });
      },
    },
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  try {
    const connecting = client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitMessage({ type: 'register_ok' });
    await connecting;
    await flushAsyncHandlers();
    ws.emitClose({ code: 1012, reason: 'service restart', wasClean: false });

    assert.equal(timers.scheduled.length, 1);
    assert.equal(timers.scheduled[0]!.delay, 1_000);
    assert.equal(client.getStatus().isReconnecting(), true);

    clock.nowMs = 600_001;
    assert.equal(timers.runNext(), true);
    await flushAsyncHandlers();

    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(
      logs.warn.some((entry) => entry.message === 'gateway.reconnect.sleep_drift_detected'),
      true,
    );
    assert.equal(
      logs.warn.some((entry) => entry.message === 'gateway.reconnect.exhausted'),
      false,
    );
    assert.equal(client.getStatus().isReconnecting(), true);
  } finally {
    client.disconnect();
    timers.restore();
  }
});

test('default reconnect preset uses forty minute active elapsed budget', () => {
  const clock = new FakeClock(0);
  const dependencies = createGatewayRuntimeDependencies({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    clock,
    random: () => 0,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  const first = dependencies.reconnectPolicy.scheduleNextAttempt();
  assert.equal(first.ok, true);

  clock.nowMs = 600_001;
  assert.equal(dependencies.reconnectPolicy.getExhaustedDecision(), null);

  clock.nowMs = DEFAULT_GATEWAY_RECONNECT_MAX_ELAPSED_MS + 1;
  assert.deepEqual(dependencies.reconnectPolicy.getExhaustedDecision(), {
    ok: false,
    elapsedMs: 2_400_001,
    maxElapsedMs: DEFAULT_GATEWAY_RECONNECT_MAX_ELAPSED_MS,
  });
});

test('default reconnect policy exhausts after active maxElapsedMs', () => {
  const clock = new FakeClock(0);
  const policy = new DefaultReconnectPolicy(
    {
      baseMs: 1_000,
      maxMs: 30_000,
      exponential: true,
      jitter: 'none',
      maxElapsedMs: 2_400_000,
      enabled: true,
    },
    { clock, random: () => 0 },
  );

  const first = policy.scheduleNextAttempt();
  assert.equal(first.ok, true);

  clock.nowMs = 2_400_001;
  assert.deepEqual(policy.getExhaustedDecision(), {
    ok: false,
    elapsedMs: 2_400_001,
    maxElapsedMs: 2_400_000,
  });
});

test('default reconnect policy excludes delayed timer drift from elapsed budget', () => {
  const clock = new FakeClock(0);
  const policy = new DefaultReconnectPolicy(
    {
      baseMs: 1_000,
      maxMs: 30_000,
      exponential: true,
      jitter: 'none',
      maxElapsedMs: 2_400_000,
      enabled: true,
    },
    { clock, random: () => 0 },
  );

  const first = policy.scheduleNextAttempt();
  assert.equal(first.ok, true);
  assert.equal(first.ok ? first.delayMs : undefined, 1_000);

  clock.nowMs = 8 * 60 * 60 * 1_000;
  policy.recordSuspendedDuration(clock.nowMs - 1_000);

  assert.equal(policy.getExhaustedDecision(), null);
  const second = policy.scheduleNextAttempt();
  assert.equal(second.ok, true);
  assert.equal(second.ok ? second.elapsedMs : undefined, 1_000);
});

test('unexpected retryable close uses injected reconnect scheduler instead of runtime setTimeout', async () => {
  FakeWebSocket.instances = [];
  const scheduler = new FakeReconnectScheduler();
  const timers = installFakeTimeouts();
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    reconnectScheduler: scheduler,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  try {
    const connecting = client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitMessage({ type: 'register_ok' });
    await connecting;
    await flushAsyncHandlers();
    ws.emitClose({ code: 1012, reason: 'service restart', wasClean: false });

    assert.equal(scheduler.scheduled.length, 1);
    assert.equal(scheduler.scheduled[0]!.delayMs, 1_000);
    assert.equal(timers.scheduled.length, 0);

    client.disconnect();
    assert.equal(scheduler.cancelCount > 0, true);
  } finally {
    timers.restore();
  }
});

test('abort keeps GATEWAY_CONNECT_ABORTED even when transport close synchronously fires onClose', async () => {
  class SyncCloseTransport extends FakeTransport {
    override close(): void {
      super.close();
      this.emitClose({ code: 1000, reason: 'abort', wasClean: true });
    }
  }

  const transport = new SyncCloseTransport();
  const controller = new AbortController();
  const errors: GatewayClientError[] = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      abortSignal: controller.signal,
    },
    buildFakeDependencies({ transport }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  controller.abort();

  let rejection: GatewayClientError | undefined;
  await assert.rejects(
    connecting,
    (error) => {
      rejection = error as GatewayClientError;
      return error instanceof GatewayClientError
        && error.code === 'GATEWAY_CONNECT_ABORTED'
        && error.disposition === 'cancelled';
    },
  );
  assert.equal(errors.length, 0);
  assert.equal(rejection?.retryable, false);
  assertClosedWithError(runtime.getStatus(), 'GATEWAY_CONNECT_ABORTED');
  assert.equal(runtime.getStatus().isCancelled(), true);
});

test('abort-triggered reconnectable close keeps reconnectPlanned false and does not schedule reconnect', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const controller = new AbortController();
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      abortSignal: controller.signal,
      logger: {
        warn(message, meta) {
          logs.push({ message, meta });
        },
      },
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    createFakeSink(),
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await connecting;

  controller.abort();
  transport.emitClose({ code: 1013, reason: 'abort close', wasClean: false });

  assert.equal(reconnectScheduler.scheduled.length, 0);
  const closeLog = logs.find((entry) => entry.message === 'gateway.close');
  assert.equal(closeLog?.meta?.reconnectPlanned, false);
  assertClosedWithError(runtime.getStatus(), 'GATEWAY_CONNECT_ABORTED');
  assert.equal(runtime.getStatus().isCancelled(), true);
});

test('manual disconnect ignores late handshake and business frames', async () => {
  FakeWebSocket.instances = [];
  const inbound: unknown[] = [];
  const messages: unknown[] = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('inbound', (message) => inbound.push(message));
  client.on('message', (message) => messages.push(message));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await client.disconnect();
  await assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_CONNECT_ABORTED'
      && error.disposition === 'cancelled'
  );
  await flushAsyncHandlers();

  ws.emitMessage({ type: 'register_ok' });
  ws.emitMessage({ type: 'status_query' });
  await flushAsyncHandlers();

  assert.equal(inbound.length, 0);
  assert.equal(messages.length, 0);
  assertClosedWithError(client.getStatus(), 'GATEWAY_CLOSED_MANUAL');
});

test('websocket error before READY waits for close and does not schedule reconnect on non-whitelist code', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const errors: GatewayClientError[] = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitError({ message: 'socket failed' });
  await assertPromisePending(connecting);
  transport.emitClose({ code: 1011, reason: 'upstream reset', wasClean: false });

  await assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_TRANSPORT_ERROR'
      && error.disposition === 'startup_failure'
  );
  assert.equal(reconnectScheduler.scheduled.length, 0);
  assert.equal(errors.length, 0);

  transport.emitError({ message: 'late socket failed' });
  assert.equal(reconnectScheduler.scheduled.length, 0);
  assert.equal(errors.length, 0);
});

test('connect failure closes with startup failure status and never emits ready', async () => {
  const transport = new FakeTransport();
  const statuses: GatewayClientStatus[] = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport }),
    {
      ...createFakeSink(),
      emitStatusChange(status) {
        statuses.push(status);
      },
    },
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  await assertPromisePending(connecting);
  transport.emitError({ message: 'socket error before ready' });
  transport.emitClose({ code: 1006, reason: 'abnormal', wasClean: false });

  let rejection: GatewayClientError | undefined;
  await assert.rejects(connecting, (error) => {
    rejection = error as GatewayClientError;
    return error instanceof GatewayClientError
      && error.code === 'GATEWAY_TRANSPORT_ERROR'
      && error.disposition === 'startup_failure';
  });

  const status = runtime.getStatus();
  assert.equal(status.isClosed(), true);
  assert.equal(status.isFailureClosed(), true);
  assert.equal(status.isRetryable(), true);
  assert.equal(status.getError(), rejection);
  assert.equal(status.getError()?.message, 'gateway_startup_transport_error');
  assert.deepEqual(statuses.map(statusKind), ['connecting', 'closed']);
});

test('pre-open rejection close still wins when websocket error arrives before close', async () => {
  for (const closeCode of [4403, 4409] as const) {
    const transport = new FakeTransport();
    const errors: GatewayClientError[] = [];
    const runtime = new GatewayClientRuntime(
      {
        url: 'ws://localhost:8081/ws/agent',
        registerMessage: registerMessage(),
      },
      buildFakeDependencies({ transport }),
      {
        ...createFakeSink(),
        emitError(error) {
          errors.push(error);
        },
      },
    );

    const connecting = runtime.connect();
    transport.emitError({ message: 'socket failed before open' });
    await assertPromisePending(connecting);
    transport.emitClose({ code: closeCode, reason: 'auth rejected', wasClean: false });

    await assert.rejects(
      connecting,
      (error) => error instanceof GatewayClientError
        && error.code === 'GATEWAY_AUTH_REJECTED'
        && error.disposition === 'startup_failure'
    );
    assert.equal(errors.length, 0);
    assertClosedWithError(runtime.getStatus(), 'GATEWAY_AUTH_REJECTED');
  }
});

test('startup multiple websocket errors preserve the first pending transport fact before close', async () => {
  const transport = new FakeTransport();
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport }),
    createFakeSink(),
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitError({ message: 'first transport error' });
  transport.emitError({ message: 'second transport error' });
  await assertPromisePending(connecting);
  transport.emitClose({ code: 1011, reason: 'upstream reset', wasClean: false });

  await assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_TRANSPORT_ERROR'
      && error.disposition === 'startup_failure'
      && error.details?.errorDetail === 'first transport error',
  );
});

test('pre-ready whitelist close codes never schedule reconnect and log reconnectPlanned false', async () => {
  for (const closeCode of [1006, 1012, 1013] as const) {
    const transport = new FakeTransport();
    const reconnectScheduler = new FakeReconnectScheduler();
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const runtime = new GatewayClientRuntime(
      {
        url: 'ws://localhost:8081/ws/agent',
        registerMessage: registerMessage(),
        logger: {
          warn(message, meta) {
            logs.push({ message, meta });
          },
        },
      },
      buildFakeDependencies({ transport, reconnectScheduler }),
      createFakeSink(),
    );

    const connecting = runtime.connect();
    transport.emitClose({ code: closeCode, reason: 'pre-ready close', wasClean: false });

    await assert.rejects(
      connecting,
      (error) => error instanceof GatewayClientError
        && error.code === 'GATEWAY_TRANSPORT_ERROR'
        && error.disposition === 'startup_failure'
    );
    assert.equal(reconnectScheduler.scheduled.length, 0);
    const closeLog = logs.find((entry) => entry.message === 'gateway.close');
    assert.equal(closeLog?.meta?.reconnectPlanned, false);
  }
});

test('invalid url connect rejects as promise and does not retain active attempt', async () => {
  const runtime = new GatewayClientRuntime(
    {
      url: 'not-a-valid-url',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies(),
    createFakeSink(),
  );

  let firstRejection: GatewayClientError | undefined;
  await assert.rejects(
    runtime.connect(),
    (error) => {
      firstRejection = error as GatewayClientError;
      return error instanceof GatewayClientError
        && error.code === 'GATEWAY_CONNECT_PARAMETER_INVALID'
        && error.disposition === 'startup_failure';
    },
  );
  let secondRejection: GatewayClientError | undefined;
  await assert.rejects(
    runtime.connect(),
    (error) => {
      secondRejection = error as GatewayClientError;
      return error instanceof GatewayClientError
        && error.code === 'GATEWAY_CONNECT_PARAMETER_INVALID'
        && error.disposition === 'startup_failure';
    },
  );
  assert.equal(secondRejection?.code, firstRejection?.code);
});

test('auth payload and transport open sync failures reject as promises', async () => {
  class ThrowingTransport extends FakeTransport {
    override open(): void {
      throw new Error('socket_factory_failed');
    }
  }

  const authRuntime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      authPayloadProvider: () => {
        throw new Error('auth_payload_failed');
      },
    },
    buildFakeDependencies(),
    createFakeSink(),
  );

  await assert.rejects(
    authRuntime.connect(),
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_CONNECT_PARAMETER_INVALID'
      && error.disposition === 'startup_failure'
      && error.message === 'auth_payload_failed',
  );

  const transportRuntime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport: new ThrowingTransport() }),
    createFakeSink(),
  );

  await assert.rejects(
    transportRuntime.connect(),
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_CONNECT_PARAMETER_INVALID'
      && error.disposition === 'startup_failure'
      && error.message === 'socket_factory_failed',
  );
});

test('debug mode logs raw onError and onClose frames before close-based settlement', async () => {
  const transport = new FakeTransport();
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      debug: true,
      logger: {
        info(message, meta) {
          logs.push({ message, meta });
        },
        warn(message, meta) {
          logs.push({ message, meta });
        },
        error(message, meta) {
          logs.push({ message, meta });
        },
      },
    },
    buildFakeDependencies({ transport }),
    createFakeSink(),
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitError({ type: 'error', message: 'socket failed' });
  transport.emitClose({ code: 1011, reason: 'upstream reset', wasClean: false });

  await assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError && error.code === 'GATEWAY_TRANSPORT_ERROR',
  );
  assert.equal(logs.some((entry) => entry.message.includes('「onError」')), true);
  assert.equal(logs.some((entry) => entry.message.includes('「onClose」')), true);
  assert.equal(logs.some((entry) => entry.message === 'gateway.close'), true);
});

test('debug mode extracts non-enumerable websocket event fields into raw frame logs', async () => {
  const transport = new FakeTransport();
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      debug: true,
      logger: {
        info(message, meta) {
          logs.push({ message, meta });
        },
        warn(message, meta) {
          logs.push({ message, meta });
        },
        error(message, meta) {
          logs.push({ message, meta });
        },
      },
    },
    buildFakeDependencies({ transport }),
    createFakeSink(),
  );

  const closeTarget = {};
  Object.defineProperties(closeTarget, {
    readyState: { value: 3, enumerable: false },
    url: { value: 'ws://localhost:8081/ws/agent', enumerable: false },
  });

  const errorEvent = {};
  Object.defineProperties(errorEvent, {
    type: { value: 'error', enumerable: false },
    message: { value: 'socket failed', enumerable: false },
    isTrusted: { value: true, enumerable: false },
    target: { value: closeTarget, enumerable: false },
  });

  const closeEvent = {};
  Object.defineProperties(closeEvent, {
    code: { value: 1006, enumerable: false },
    reason: { value: 'Failed to connect', enumerable: false },
    wasClean: { value: false, enumerable: false },
    isTrusted: { value: true, enumerable: false },
    target: { value: closeTarget, enumerable: false },
  });

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitError(errorEvent);
  transport.emitClose(closeEvent);

  await assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError && error.code === 'GATEWAY_TRANSPORT_ERROR',
  );

  const rawErrorLog = logs.find((entry) => entry.message.includes('「onError」'));
  const rawCloseLog = logs.find((entry) => entry.message.includes('「onClose」'));
  assert.notEqual(rawErrorLog, undefined);
  assert.notEqual(rawCloseLog, undefined);
  assert.equal(rawErrorLog.message.includes('"message":"socket failed"'), true);
  assert.equal(rawErrorLog.message.includes('"readyState":3'), true);
  assert.equal(rawCloseLog.message.includes('"code":1006'), true);
  assert.equal(rawCloseLog.message.includes('"reason":"Failed to connect"'), true);
  assert.equal(rawCloseLog.message.includes('"wasClean":false'), true);
});

test('debug mode preserves enumerable transport diagnostics while enriching event fields', async () => {
  const transport = new FakeTransport();
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      debug: true,
      logger: {
        info(message, meta) {
          logs.push({ message, meta });
        },
        warn(message, meta) {
          logs.push({ message, meta });
        },
        error(message, meta) {
          logs.push({ message, meta });
        },
      },
    },
    buildFakeDependencies({ transport }),
    createFakeSink(),
  );

  const closeTarget = {};
  Object.defineProperties(closeTarget, {
    readyState: { value: 3, enumerable: false },
    url: { value: 'ws://localhost:8081/ws/agent', enumerable: false },
  });

  const transportError = Object.assign(new Error('socket failed'), { code: 'ECONNRESET' });
  const errorEvent = {
    attemptId: 'attempt-1',
    detail: { retryInMs: 500 },
  };
  Object.defineProperties(errorEvent, {
    type: { value: 'error', enumerable: false },
    message: { value: 'socket failed', enumerable: false },
    error: { value: transportError, enumerable: false },
    target: { value: closeTarget, enumerable: false },
  });

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitError(errorEvent);
  transport.emitClose({ code: 1011, reason: 'upstream reset', wasClean: false });

  await assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError && error.code === 'GATEWAY_TRANSPORT_ERROR',
  );

  const rawErrorLog = logs.find((entry) => entry.message.includes('「onError」'));
  assert.notEqual(rawErrorLog, undefined);
  assert.equal(rawErrorLog.message.includes('"attemptId":"attempt-1"'), true);
  assert.equal(rawErrorLog.message.includes('"retryInMs":500'), true);
  assert.equal(rawErrorLog.message.includes('"message":"socket failed"'), true);
  assert.equal(rawErrorLog.message.includes('"code":"ECONNRESET"'), true);
});

test('onClose raw frame logging stays debug-gated while structured gateway.close remains enabled', async () => {
  const transport = new FakeTransport();
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger: {
        info(message, meta) {
          logs.push({ message, meta });
        },
        warn(message, meta) {
          logs.push({ message, meta });
        },
      },
    },
    buildFakeDependencies({ transport }),
    createFakeSink(),
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitClose({ code: 1011, reason: 'upstream reset', wasClean: false });

  await assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError && error.code === 'GATEWAY_TRANSPORT_ERROR',
  );
  assert.equal(logs.some((entry) => entry.message.includes('「onClose」')), false);
  assert.equal(logs.some((entry) => entry.message === 'gateway.close'), true);
});

test('async inbound handler exceptions are emitted as protocol errors', async () => {
  const transport = new FakeTransport();
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger: {
        error(message, meta) {
          logs.push({ message, meta });
        },
      },
    },
    buildFakeDependencies({
      transport,
      wireCodec: {
        normalizeDownstream() {
          throw new Error('normalize_failed');
        },
        validateGatewayUplinkBusinessMessage(raw) {
          return new GatewaySchemaCodecAdapter().validateGatewayUplinkBusinessMessage(raw);
        },
        validateGatewayUpstreamTransportMessage(raw) {
          return new GatewaySchemaCodecAdapter().validateGatewayUpstreamTransportMessage(raw);
        },
        validateGatewayWireProtocolMessage(raw) {
          return new GatewaySchemaCodecAdapter().validateGatewayWireProtocolMessage(raw);
        },
      },
    }),
    createFakeSink(),
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await connecting;

  transport.emitMessage({ type: 'status_query' });
  await flushAsyncHandlers();

  assert.equal(logs[0]?.message, 'gateway.message.failure');
  assert.equal(logs[0]?.meta?.error, 'normalize_failed');
});

test('handshake timeout rejects the active connect attempt', async () => {
  const transport = new FakeTransport();
  const timers = installFakeTimeouts();
  const errors: GatewayClientError[] = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      handshakeTimeoutMs: 25,
    },
    buildFakeDependencies({ transport }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  try {
    const connecting = runtime.connect();
    transport.emitOpen();

    assert.equal(timers.scheduled.length > 0, true);
    assert.equal(timers.runNext(), true);

    let rejection: GatewayClientError | undefined;
    await assert.rejects(
      connecting,
      (error) => {
        rejection = error as GatewayClientError;
        return error instanceof GatewayClientError
          && error.code === 'GATEWAY_HANDSHAKE_TIMEOUT'
          && error.disposition === 'startup_failure';
      },
    );
    assert.equal(errors.length, 0);
    assert.equal(rejection?.code, 'GATEWAY_HANDSHAKE_TIMEOUT');
  } finally {
    timers.restore();
  }
});

test('invalid handshake control never schedules reconnect after follow-up close', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const fallbackCodec = new GatewaySchemaCodecAdapter();
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({
      transport,
      reconnectScheduler,
      wireCodec: {
        normalizeDownstream(raw) {
          return fallbackCodec.normalizeDownstream(raw);
        },
        validateGatewayUplinkBusinessMessage(raw) {
          return fallbackCodec.validateGatewayUplinkBusinessMessage(raw);
        },
        validateGatewayUpstreamTransportMessage(raw) {
          if (
            raw
            && typeof raw === 'object'
            && 'type' in raw
            && (raw as { type?: unknown }).type === 'register_rejected'
          ) {
            return {
              ok: false as const,
              error: {
                violation: {
                  stage: 'transport',
                  code: 'invalid_payload',
                  field: 'reason',
                  message: 'register_rejected reason is invalid',
                  messageType: 'register_rejected',
                },
              },
            };
          }
          return fallbackCodec.validateGatewayUpstreamTransportMessage(raw);
        },
        validateGatewayWireProtocolMessage(raw) {
          return fallbackCodec.validateGatewayWireProtocolMessage(raw);
        },
      },
    }),
    createFakeSink(),
  );

  const connecting = runtime.connect();
  const rejection = assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError && error.code === 'GATEWAY_HANDSHAKE_INVALID',
  );
  transport.emitOpen();
  transport.emitMessage({ type: 'register_rejected', reason: 'bad-aksk' });
  await flushAsyncHandlers();
  transport.emitClose({ code: 1011, reason: 'upstream reset', wasClean: false });

  await rejection;
  assert.equal(reconnectScheduler.scheduled.length, 0);
});

test('explicit handshake terminal error is not overwritten by later transport callbacks', async () => {
  const transport = new FakeTransport();
  const errors: GatewayClientError[] = [];
  const fallbackCodec = new GatewaySchemaCodecAdapter();
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({
      transport,
      wireCodec: {
        normalizeDownstream(raw) {
          return fallbackCodec.normalizeDownstream(raw);
        },
        validateGatewayUplinkBusinessMessage(raw) {
          return fallbackCodec.validateGatewayUplinkBusinessMessage(raw);
        },
        validateGatewayUpstreamTransportMessage(raw) {
          if (
            raw
            && typeof raw === 'object'
            && 'type' in raw
            && (raw as { type?: unknown }).type === 'register_rejected'
          ) {
            return {
              ok: false as const,
              error: {
                violation: {
                  stage: 'transport',
                  code: 'invalid_payload',
                  field: 'reason',
                  message: 'register_rejected reason is invalid',
                  messageType: 'register_rejected',
                },
              },
            };
          }
          return fallbackCodec.validateGatewayUpstreamTransportMessage(raw);
        },
        validateGatewayWireProtocolMessage(raw) {
          return fallbackCodec.validateGatewayWireProtocolMessage(raw);
        },
      },
    }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  const connecting = runtime.connect();
  const rejection = assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_HANDSHAKE_INVALID'
      && error.disposition === 'startup_failure'
      && error.details?.messageType === 'register_rejected',
  );
  transport.emitOpen();
  transport.emitMessage({ type: 'register_rejected', reason: 'bad-aksk' });
  await flushAsyncHandlers();
  transport.emitError({ message: 'late transport error after handshake failure' });
  transport.emitClose({ code: 1011, reason: 'upstream reset', wasClean: false });

  await rejection;
  assert.equal(errors.length, 0);
});

test('register send failure never schedules reconnect', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({
      transport,
      reconnectScheduler,
      outboundProtocolGate: {
        validateBusiness(message) {
          return message;
        },
        validateControl() {
          throw new GatewayClientError({
            code: 'GATEWAY_OUTBOUND_PROTOCOL_INVALID',
            disposition: 'diagnostic',
            retryable: false,
            message: 'register_invalid',
          });
        },
      },
    }),
    createFakeSink(),
  );

  const connecting = runtime.connect();
  transport.emitOpen();

  await assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError && error.code === 'GATEWAY_CONNECT_PARAMETER_INVALID',
  );
  assert.equal(reconnectScheduler.scheduled.length, 0);
});

test('READY close retries on close code 1013', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const errors: GatewayClientError[] = [];
  const warnLogs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const infoLogs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger: {
        info(message, meta) {
          infoLogs.push({ message, meta });
        },
        warn(message, meta) {
          warnLogs.push({ message, meta });
        },
      },
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await connecting;

  transport.emitClose({ code: 1013, reason: 'try again later', wasClean: false });

  assert.equal(errors.length, 0);
  assert.equal(runtime.getStatus().isReconnecting(), true);
  assert.equal(reconnectScheduler.scheduled.length, 1);
  assert.equal(
    warnLogs.filter((entry) => entry.message === 'gateway.reconnect.scheduled').length,
    1,
  );
  assert.equal(
    infoLogs.filter((entry) => entry.message === 'gateway.reconnect.scheduled').length,
    0,
  );
});

test('manual disconnect after reconnectable ready close keeps reconnectPlanned false and does not schedule reconnect', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger: {
        warn(message, meta) {
          logs.push({ message, meta });
        },
      },
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    createFakeSink(),
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await connecting;

  await runtime.disconnect();
  transport.emitClose({ code: 1013, reason: 'manual close', wasClean: false });

  assert.equal(reconnectScheduler.scheduled.length, 0);
  assert.equal(logs.some((entry) => entry.message === 'gateway.close'), false);
  assertClosedWithError(runtime.getStatus(), 'GATEWAY_CLOSED_MANUAL');
});

test('READY websocket error still retries when follow-up close code is reconnectable', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const errors: GatewayClientError[] = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await connecting;

  transport.emitError({ message: 'socket failed after ready' });
  assert.equal(errors.length, 0);
  transport.emitClose({ code: 1013, reason: 'try again later', wasClean: false });

  assert.equal(errors.length, 0);
  assert.equal(runtime.getStatus().isReconnecting(), true);
  assert.equal(reconnectScheduler.scheduled.length, 1);
});

test('READY rejection close does not reconnect and maps to remote unavailable', async () => {
  for (const closeCode of [4403, 4409] as const) {
    const transport = new FakeTransport();
    const reconnectScheduler = new FakeReconnectScheduler();
    const errors: GatewayClientError[] = [];
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const runtime = new GatewayClientRuntime(
      {
        url: 'ws://localhost:8081/ws/agent',
        registerMessage: registerMessage(),
        logger: {
          warn(message, meta) {
            logs.push({ message, meta });
          },
        },
      },
      buildFakeDependencies({ transport, reconnectScheduler }),
      {
        ...createFakeSink(),
        emitError(error) {
          errors.push(error);
        },
      },
    );

    const connecting = runtime.connect();
    transport.emitOpen();
    transport.emitMessage({ type: 'register_ok' });
    await connecting;

    transport.emitClose({ code: closeCode, reason: 'auth rejected', wasClean: false });

    assert.equal(reconnectScheduler.scheduled.length, 0);
    assert.equal(errors.length, 0);
    assert.equal(runtime.getStatus().isClosed(), true);
    assert.equal(runtime.getStatus().getError()?.code, 'GATEWAY_AUTH_REJECTED');
    const rejectionLog = logs.find((entry) => entry.message === 'gateway.close.rejected');
    assert.equal(rejectionLog?.meta?.rejected, true);
    assert.equal(rejectionLog?.meta?.code, closeCode);
  }
});

test('READY register-timeout close starts reconnect window and keeps transport availability semantics', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const errors: GatewayClientError[] = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await connecting;

  transport.emitClose({ code: 4408, reason: 'register timeout', wasClean: false });

  assert.equal(reconnectScheduler.scheduled.length, 1);
  assert.equal(errors.length, 0);
  assert.equal(runtime.getStatus().isReconnecting(), true);
});

test('READY multiple websocket errors still emit only one runtime terminal failure after close', async () => {
  const transport = new FakeTransport();
  const errors: GatewayClientError[] = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await connecting;

  transport.emitError({ message: 'first runtime transport error' });
  transport.emitError({ message: 'second runtime transport error' });
  assert.equal(errors.length, 0);
  transport.emitClose({ code: 1011, reason: 'runtime reset', wasClean: false });
  transport.emitClose({ code: 1011, reason: 'duplicate late close', wasClean: false });

  assert.equal(errors.length, 0);
  assert.equal(runtime.getStatus().isClosed(), true);
  assert.equal(runtime.getStatus().getError()?.code, 'GATEWAY_TRANSPORT_ERROR');
});

test('READY close does not retry on undefined, 1005, 1011, or unknown 4xxx codes', async () => {
  for (const closeCode of [undefined, 1005, 1011, 4500] as const) {
    const transport = new FakeTransport();
    const reconnectScheduler = new FakeReconnectScheduler();
    const runtime = new GatewayClientRuntime(
      {
        url: 'ws://localhost:8081/ws/agent',
        registerMessage: registerMessage(),
      },
      buildFakeDependencies({ transport, reconnectScheduler }),
      createFakeSink(),
    );

    const connecting = runtime.connect();
    transport.emitOpen();
    transport.emitMessage({ type: 'register_ok' });
    await connecting;

    transport.emitClose({ code: closeCode, reason: 'not-whitelisted', wasClean: false });

    assert.equal(reconnectScheduler.scheduled.length, 0);
  }
});

test('reconnect attempt stops backoff after register_rejected', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    createFakeSink(),
  );

  const initialConnect = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await initialConnect;

  transport.emitClose({ code: 1006, reason: 'network drop', wasClean: false });
  assert.equal(reconnectScheduler.scheduled.length, 1);

  const reconnectTask = reconnectScheduler.scheduled[0]!.task();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_rejected', reason: 'duplicate_connection' });
  await reconnectTask;

  assert.equal(reconnectScheduler.scheduled.length, 1);
  assert.equal(runtime.getStatus().isClosed(), true);
});

test('reconnect window send guards use current connection status', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    createFakeSink(),
  );

  const initialConnect = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await initialConnect;

  transport.emitClose({ code: 1006, reason: 'network drop', wasClean: false });
  assert.equal(reconnectScheduler.scheduled.length, 1);

  assert.throws(
    () => runtime.send({ type: 'tool_done', toolSessionId: 'tool-1' }),
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_NOT_CONNECTED'
      && error.disposition === 'diagnostic'
  );

  const reconnectTask = reconnectScheduler.scheduled[0]!.task();
  transport.emitOpen();

  assert.throws(
    () => runtime.send({ type: 'tool_done', toolSessionId: 'tool-1' }),
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_NOT_READY'
      && error.disposition === 'diagnostic'
  );

  transport.emitClose({ code: 1011, reason: 'retry open failed', wasClean: false });
  await reconnectTask;
});

test('reconnect attempt pre-open whitelist close continues next attempt inside reconnect window', async () => {
  for (const closeCode of [1006, 4408] as const) {
    const transport = new FakeTransport();
    const reconnectScheduler = new FakeReconnectScheduler();
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const runtime = new GatewayClientRuntime(
      {
        url: 'ws://localhost:8081/ws/agent',
        registerMessage: registerMessage(),
        logger: {
          warn(message, meta) {
            logs.push({ message, meta });
          },
        },
      },
      buildFakeDependencies({ transport, reconnectScheduler }),
      createFakeSink(),
    );

    const initialConnect = runtime.connect();
    transport.emitOpen();
    transport.emitMessage({ type: 'register_ok' });
    await initialConnect;

    transport.emitClose({ code: 1006, reason: 'network drop', wasClean: false });
    const reconnectTask = reconnectScheduler.scheduled[0]!.task();
    transport.emitClose({ code: closeCode, reason: 'retry open failed', wasClean: false });
    await reconnectTask;

    assert.equal(reconnectScheduler.scheduled.length, 2);
    const failedLog = logs.find((entry) => entry.message === 'gateway.reconnect.failed');
    assert.equal(failedLog, undefined);
  }
});

test('reconnect attempt handshake whitelist close continues next attempt inside reconnect window', async () => {
  for (const closeCode of [1012, 1013, 4408] as const) {
    const transport = new FakeTransport();
    const reconnectScheduler = new FakeReconnectScheduler();
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const runtime = new GatewayClientRuntime(
      {
        url: 'ws://localhost:8081/ws/agent',
        registerMessage: registerMessage(),
        logger: {
          warn(message, meta) {
            logs.push({ message, meta });
          },
        },
      },
      buildFakeDependencies({ transport, reconnectScheduler }),
      createFakeSink(),
    );

    const initialConnect = runtime.connect();
    transport.emitOpen();
    transport.emitMessage({ type: 'register_ok' });
    await initialConnect;

    transport.emitClose({ code: 1006, reason: 'network drop', wasClean: false });
    const reconnectTask = reconnectScheduler.scheduled[0]!.task();
    transport.emitOpen();
    transport.emitClose({ code: closeCode, reason: 'retry interrupted', wasClean: false });
    await reconnectTask;

    assert.equal(reconnectScheduler.scheduled.length, 2);
    const failedLog = logs.find((entry) => entry.message === 'gateway.reconnect.failed');
    assert.equal(failedLog, undefined);
  }
});

test('reconnect attempt whitelist close clears reconnecting when next retry is exhausted', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const errors: GatewayClientError[] = [];
  let scheduleCount = 0;
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger: {
        warn(message, meta) {
          logs.push({ message, meta });
        },
      },
    },
    buildFakeDependencies({
      transport,
      reconnectScheduler,
      reconnectPolicy: {
        startWindow() {},
        reset() {},
        recordSuspendedDuration() {},
        scheduleNextAttempt() {
          scheduleCount += 1;
          if (scheduleCount === 1) {
            return {
              ok: true as const,
              attempt: 1,
              delayMs: 250,
              elapsedMs: 0,
            };
          }
          return {
            ok: false as const,
            elapsedMs: 250,
            maxElapsedMs: 250,
          };
        },
        getExhaustedDecision() {
          return scheduleCount >= 2
            ? {
              ok: false as const,
              elapsedMs: 250,
              maxElapsedMs: 250,
            }
            : null;
        },
      },
    }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  const initialConnect = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await initialConnect;

  transport.emitClose({ code: 4408, reason: 'register timeout', wasClean: false });
  const reconnectTask = reconnectScheduler.scheduled[0]!.task();
  transport.emitClose({ code: 4408, reason: 'retry register timeout', wasClean: false });
  await reconnectTask;

  assert.equal(runtime.getStatus().isClosed(), true);
  assert.equal(runtime.getStatus().getError()?.code, 'GATEWAY_RECONNECT_EXHAUSTED');
  assert.equal(
    logs.some((entry) => entry.message === 'gateway.reconnect.exhausted'),
    true,
  );
});

test('reconnect attempt stops backoff after handshake protocol violation', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const fallbackCodec = new GatewaySchemaCodecAdapter();
  let attempt = 0;
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({
      transport,
      reconnectScheduler,
      wireCodec: {
        normalizeDownstream(raw) {
          return fallbackCodec.normalizeDownstream(raw);
        },
        validateGatewayUplinkBusinessMessage(raw) {
          return fallbackCodec.validateGatewayUplinkBusinessMessage(raw);
        },
        validateGatewayUpstreamTransportMessage(raw) {
          if (
            attempt >= 2
            && raw
            && typeof raw === 'object'
            && 'type' in raw
            && (raw as { type?: unknown }).type === 'register_rejected'
          ) {
            return {
              ok: false as const,
              error: {
                violation: {
                  stage: 'transport',
                  code: 'invalid_payload',
                  field: 'reason',
                  message: 'register_rejected reason is invalid',
                  messageType: 'register_rejected',
                },
              },
            };
          }
          return fallbackCodec.validateGatewayUpstreamTransportMessage(raw);
        },
        validateGatewayWireProtocolMessage(raw) {
          return fallbackCodec.validateGatewayWireProtocolMessage(raw);
        },
      },
    }),
    createFakeSink(),
  );

  const initialConnect = runtime.connect();
  attempt += 1;
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await initialConnect;

  transport.emitClose({ code: 1006, reason: 'network drop', wasClean: false });
  assert.equal(reconnectScheduler.scheduled.length, 1);

  const reconnectTask = reconnectScheduler.scheduled[0]!.task();
  attempt += 1;
  transport.emitOpen();
  transport.emitMessage({ type: 'register_rejected', reason: 'bad-aksk' });
  await flushAsyncHandlers();

  await reconnectTask;
  assert.equal(reconnectScheduler.scheduled.length, 1);
  assert.equal(runtime.getStatus().isClosed(), true);
});

test('reconnect attempt handshake failures stay on connect reject path', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const errors: GatewayClientError[] = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  const initialConnect = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await initialConnect;

  transport.emitClose({ code: 1006, reason: 'network drop', wasClean: false });
  const runtimeErrorCount = errors.length;
  const reconnectTask = reconnectScheduler.scheduled[0]!.task();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_rejected', reason: 'duplicate_connection' });
  await reconnectTask;

  assert.equal(errors.length, runtimeErrorCount);
});

test('reconnect attempt timeout stays on connect reject path', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const errors: GatewayClientError[] = [];
  const timers = installFakeTimeouts();
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      handshakeTimeoutMs: 25,
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  try {
    const initialConnect = runtime.connect();
    transport.emitOpen();
    transport.emitMessage({ type: 'register_ok' });
    await initialConnect;

    transport.emitClose({ code: 1006, reason: 'network drop', wasClean: false });
    const runtimeErrorCount = errors.length;
    const timeoutTask = reconnectScheduler.scheduled[0]!.task();
    transport.emitOpen();
    assert.equal(timers.runNextActive(), true);
    await timeoutTask;

    assert.equal(errors.length, runtimeErrorCount);
  } finally {
    timers.restore();
  }
});

test('reconnect attempt websocket error stays on connect reject path', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const errors: GatewayClientError[] = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  const initialConnect = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await initialConnect;

  transport.emitClose({ code: 1006, reason: 'network drop', wasClean: false });
  const runtimeErrorCount = errors.length;
  const reconnectTask = reconnectScheduler.scheduled[0]!.task();
  transport.emitOpen();
  transport.emitError({ message: 'socket failed during reconnect' });
  await flushAsyncHandlers();
  assert.equal(errors.length, runtimeErrorCount);
  transport.emitClose({ code: 1011, reason: 'retry failed', wasClean: false });
  await reconnectTask;

  assert.equal(errors.length, runtimeErrorCount);
});

test('reconnect attempt unexpected close after open stays handshake startup failure', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger: {
        warn(message, meta) {
          logs.push({ message, meta });
        },
      },
    },
    buildFakeDependencies({ transport, reconnectScheduler }),
    createFakeSink(),
  );

  const initialConnect = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await initialConnect;

  transport.emitClose({ code: 1006, reason: 'network drop', wasClean: false });
  const reconnectTask = reconnectScheduler.scheduled[0]!.task();
  transport.emitOpen();
  transport.emitClose({ code: 1011, reason: 'retry handshake interrupted', wasClean: false });
  await reconnectTask;

  const failedLog = logs.find((entry) => entry.message === 'gateway.reconnect.failed');
  assert.equal(failedLog?.meta?.code, 'GATEWAY_TRANSPORT_ERROR');
  assert.equal(failedLog?.meta?.disposition, 'startup_failure');
  assert.equal(mapGatewayClientAvailability({
    code: String(failedLog?.meta?.code) as 'GATEWAY_TRANSPORT_ERROR',
    disposition: 'startup_failure',
    retryable: true,
    message: 'gateway_unexpected_close_before_ready',
  }), 'transport_unavailable');
});

test('reconnect attempt stops backoff after register send failure', async () => {
  const transport = new FakeTransport();
  const reconnectScheduler = new FakeReconnectScheduler();
  let validateControlCalls = 0;
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({
      transport,
      reconnectScheduler,
      outboundProtocolGate: {
        validateBusiness(message) {
          return message;
        },
        validateControl(message) {
          validateControlCalls += 1;
          if (validateControlCalls >= 2) {
            throw new GatewayClientError({
              code: 'GATEWAY_OUTBOUND_PROTOCOL_INVALID',
              disposition: 'diagnostic',
              retryable: false,
              message: 'register_invalid',
            });
          }
          return message;
        },
      },
    }),
    createFakeSink(),
  );

  const initialConnect = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await initialConnect;

  transport.emitClose({ code: 1006, reason: 'network drop', wasClean: false });
  assert.equal(reconnectScheduler.scheduled.length, 1);

  const reconnectTask = reconnectScheduler.scheduled[0]!.task();
  transport.emitOpen();

  await reconnectTask;
  assert.equal(reconnectScheduler.scheduled.length, 1);
  assert.equal(runtime.getStatus().isClosed(), true);
});

test('send guards surface structured not-connected and not-ready errors', async () => {
  FakeWebSocket.instances = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  assert.throws(
    () => client.send({ type: 'tool_done', toolSessionId: 'tool-1' }),
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_NOT_CONNECTED'
      && error.disposition === 'diagnostic'
  );

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();

  assert.throws(
    () => client.send({ type: 'tool_done', toolSessionId: 'tool-1' }),
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_NOT_READY'
      && error.disposition === 'diagnostic'
  );

  client.disconnect();
  await assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError && error.code === 'GATEWAY_CONNECT_ABORTED',
  );
});

test('public connect wraps unknown synchronous failures as GatewayClientError', async () => {
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    logger: {
      info() {
        throw new Error('logger exploded');
      },
    },
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  await assert.rejects(
    client.connect(),
    (error) => error instanceof GatewayClientError
      && error instanceof GatewayClientUnknownError
      && error.code === 'GATEWAY_UNKNOWN_ERROR'
      && error.disposition === 'startup_failure'
      && error.message === 'gateway client connect failed: logger exploded'
      && error.details === undefined
      && error.cause instanceof Error
      && error.cause.message === 'logger exploded',
  );
});

test('public connect preserves GatewayClientError failures', async () => {
  const client = createGatewayClient({
    url: 'not a websocket url',
    registerMessage: registerMessage(),
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  await assert.rejects(
    client.connect(),
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_CONNECT_PARAMETER_INVALID'
      && error.disposition === 'startup_failure',
  );
});

test('public disconnect wraps unknown synchronous failures as GatewayClientError', async () => {
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    logger: {
      info() {
        throw new Error('disconnect logger exploded');
      },
    },
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  await assert.rejects(
    client.disconnect(),
    (error) => error instanceof GatewayClientError
      && error instanceof GatewayClientUnknownError
      && error.code === 'GATEWAY_UNKNOWN_ERROR'
      && error.disposition === 'diagnostic'
      && error.message === 'gateway client disconnect failed: disconnect logger exploded'
      && error.details === undefined,
  );
});

test('public send wraps unknown synchronous failures as GatewayClientError', () => {
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    logger: {
      warn() {
        throw new Error('send logger exploded');
      },
    },
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  assert.throws(
    () => client.send({ type: 'tool_done', toolSessionId: 'tool-1' }),
    (error) => error instanceof GatewayClientError
      && error instanceof GatewayClientUnknownError
      && error.code === 'GATEWAY_UNKNOWN_ERROR'
      && error.disposition === 'diagnostic'
      && error.message === 'gateway client send failed: send logger exploded'
      && error.details === undefined,
  );
});

test('unknown gateway client error summarizes object code and message', () => {
  const error = new GatewayClientUnknownError({
    action: 'connect',
    disposition: 'startup_failure',
    cause: {
      code: 'CUSTOM_GATEWAY_FAILURE',
      message: 'custom failure',
      ignored: true,
    },
  });

  assert.equal(
    error.message,
    'gateway client connect failed: code=CUSTOM_GATEWAY_FAILURE message=custom failure',
  );
});

test('statusChange listener failures do not affect lifecycle', async () => {
  FakeWebSocket.instances = [];
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const statuses: GatewayClientStatus[] = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    logger: {
      error(message, meta) {
        logs.push({ message, meta });
      },
    },
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('statusChange', () => {
    throw new Error('listener exploded');
  });
  client.on('statusChange', (status) => statuses.push(status));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  ws.emitMessage({ type: 'register_ok' });
  await connecting;

  assert.equal(client.getStatus().isReady(), true);
  assert.equal(statuses.some((status) => status.isReady()), true);
  const listenerLog = logs.find((entry) => entry.message === 'gateway.event.listener_failed');
  assert.equal(listenerLog?.meta?.code, 'GATEWAY_UNKNOWN_ERROR');
  assert.equal(listenerLog?.meta?.disposition, 'diagnostic');
  assert.equal(listenerLog?.meta?.error, 'gateway client event:statusChange failed: listener exploded');
  assert.equal('action' in (listenerLog?.meta ?? {}), false);

  await client.disconnect();
});

test('statusChange once listener runs only once through safe event emission', async () => {
  FakeWebSocket.instances = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });
  let onceCalls = 0;

  (client as unknown as { once(event: string, listener: () => void): unknown }).once('statusChange', () => {
    onceCalls += 1;
  });

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  ws.emitMessage({ type: 'register_ok' });
  await connecting;
  await client.disconnect();

  assert.equal(onceCalls, 1);
});

test('READY websocket error keeps ready phase', async () => {
  const transport = new FakeTransport();
  const errors: GatewayClientError[] = [];
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({ transport }),
    {
      ...createFakeSink(),
      emitError(error) {
        errors.push(error);
      },
    },
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await connecting;

  transport.emitError({ message: 'socket failed after ready' });
  assert.equal(errors.length, 0);
  transport.emitClose({ code: 1011, reason: 'socket failed after ready', wasClean: false });
  assert.equal(errors.length, 0);
  assert.equal(runtime.getStatus().isClosed(), true);
  assert.equal(runtime.getStatus().getError()?.code, 'GATEWAY_TRANSPORT_ERROR');
});

test('READY protocol error keeps ready phase', async () => {
  const transport = new FakeTransport();
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    },
    buildFakeDependencies({
      transport,
      outboundProtocolGate: {
        validateBusiness() {
          throw new GatewayClientError({
            code: 'GATEWAY_OUTBOUND_PROTOCOL_INVALID',
            disposition: 'diagnostic',
            retryable: false,
            message: 'business_invalid',
          });
        },
        validateControl(message) {
          return message;
        },
      },
    }),
    createFakeSink(),
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await connecting;

  assert.throws(
    () => runtime.send({ type: 'tool_done', toolSessionId: 'tool-1' }),
    (error) => error instanceof GatewayClientError
      && error.code === 'GATEWAY_OUTBOUND_PROTOCOL_INVALID'
  );
  assert.equal(runtime.getStatus().isReady(), true);
});

test('public send rejects heartbeat while internal heartbeat still reaches transport through one gate', async () => {
  const transport = new FakeTransport();
  const runtime = new GatewayClientRuntime(
    { url: 'ws://localhost:8081/ws/agent', registerMessage: registerMessage() },
    buildFakeDependencies({ transport }),
    createFakeSink(),
  );

  assert.throws(() => runtime.send({ type: 'heartbeat' } as never), /GATEWAY_OUTBOUND_PROTOCOL_INVALID|type/i);
});

test('internal register and heartbeat use the same outbound validation gate', async () => {
  const gateCalls: string[] = [];
  const transport = new FakeTransport();
  const heartbeatScheduler = new FakeHeartbeatScheduler();
  const runtime = new GatewayClientRuntime(
    { url: 'ws://localhost:8081/ws/agent', registerMessage: registerMessage() },
    buildFakeDependencies({
      transport,
      heartbeatScheduler,
      outboundProtocolGate: {
        validateBusiness(message) {
          gateCalls.push(`business:${message.type}`);
          return message;
        },
        validateControl(message) {
          gateCalls.push(`control:${message.type}`);
          return message;
        },
      },
    }),
    createFakeSink(),
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await connecting;
  await flushAsyncHandlers();
  heartbeatScheduler.trigger();

  assert.ok(gateCalls.includes('control:register'));
  assert.ok(gateCalls.includes('control:heartbeat'));
});

test('validateControl uses upstream transport validation instead of the umbrella validator', () => {
  let upstreamTransportValidationCount = 0;
  let wireValidateCalls = 0;
  const wireCodec = {
    normalizeDownstream() {
      throw new Error('normalizeDownstream is not expected here');
    },
    validateGatewayUplinkBusinessMessage() {
      throw new Error('validateGatewayUplinkBusinessMessage is not expected here');
    },
    validateGatewayWireProtocolMessage(message: unknown) {
      wireValidateCalls += 1;
      return { ok: true as const, value: message };
    },
    validateGatewayUpstreamTransportMessage(message: unknown) {
      upstreamTransportValidationCount += 1;
      return { ok: true as const, value: message };
    },
  } satisfies {
    normalizeDownstream(raw: unknown): never;
    validateGatewayUplinkBusinessMessage(raw: unknown): never;
    validateGatewayWireProtocolMessage(raw: unknown): { ok: true; value: unknown };
    validateGatewayUpstreamTransportMessage(raw: unknown): { ok: true; value: unknown };
  };

  const gate = new DefaultOutboundProtocolGate(wireCodec as unknown as GatewayWireCodec);
  const result = gate.validateControl(registerMessage());

  assert.deepEqual(result, registerMessage());
  assert.equal(upstreamTransportValidationCount, 1);
  assert.equal(wireValidateCalls, 0);
});

test('validateBusiness uses uplink business validation instead of the umbrella validator', () => {
  let uplinkBusinessValidationCount = 0;
  let wireValidateCalls = 0;
  const wireCodec = {
    normalizeDownstream() {
      throw new Error('normalizeDownstream is not expected here');
    },
    validateGatewayUplinkBusinessMessage(message: unknown) {
      uplinkBusinessValidationCount += 1;
      return { ok: true as const, value: message };
    },
    validateGatewayWireProtocolMessage(message: unknown) {
      wireValidateCalls += 1;
      return { ok: true as const, value: message };
    },
    validateGatewayUpstreamTransportMessage() {
      throw new Error('validateGatewayUpstreamTransportMessage is not expected here');
    },
  } satisfies {
    normalizeDownstream(raw: unknown): never;
    validateGatewayUplinkBusinessMessage(raw: unknown): { ok: true; value: unknown };
    validateGatewayWireProtocolMessage(raw: unknown): { ok: true; value: unknown };
    validateGatewayUpstreamTransportMessage(raw: unknown): never;
  };

  const gate = new DefaultOutboundProtocolGate(wireCodec as unknown as GatewayWireCodec);
  const result = gate.validateBusiness({ type: 'tool_done', toolSessionId: 'tool-1' });

  assert.deepEqual(result, { type: 'tool_done', toolSessionId: 'tool-1' });
  assert.equal(uplinkBusinessValidationCount, 1);
  assert.equal(wireValidateCalls, 0);
});

test('validateBusiness accepts tool_event payloads from both canonical provider payload shapes through wire codec', () => {
  const gate = new DefaultOutboundProtocolGate(new GatewaySchemaCodecAdapter());

  const opencodeMessage = gate.validateBusiness({
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      type: 'session.idle',
      properties: {
        sessionID: 'session-1',
      },
    },
  });

  const skillMessage = gate.validateBusiness({
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      protocol: 'cloud',
      type: 'session.status',
      properties: {
        sessionStatus: 'idle',
      },
    },
  });

  assert.equal(opencodeMessage.type, 'tool_event');
  assert.equal('protocol' in opencodeMessage.event, false);
  assert.equal(skillMessage.type, 'tool_event');
  assert.equal(skillMessage.event.protocol, 'cloud');
});

test('close logging follows resolved reconnectEnabled instead of raw reconnect config', async () => {
  const transport = new FakeTransport();
  const heartbeatScheduler = new FakeHeartbeatScheduler();
  const reconnectScheduler = new FakeReconnectScheduler();
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const wireCodec = new GatewaySchemaCodecAdapter();
  const runtime = new GatewayClientRuntime(
    {
      url: 'ws://localhost:8081/ws/agent',
      reconnect: {
        enabled: true,
      },
      registerMessage: registerMessage(),
      logger: {
        warn(message, meta) {
          logs.push({ message, meta });
        },
      },
    },
    {
      transport,
      heartbeatScheduler,
      reconnectScheduler,
      reconnectEnabled: false,
      reconnectPolicy: new FakeReconnectPolicy(),
      wireCodec,
      outboundProtocolGate: {
        validateBusiness(message) {
          return message;
        },
        validateControl(message) {
          return message;
        },
      },
      businessMessageHandler: new BusinessMessageHandler(),
      authSubprotocolBuilder: () => 'auth.test',
    } satisfies GatewayClientRuntimeDependencies,
    createFakeSink(),
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  transport.emitMessage({ type: 'register_ok' });
  await connecting;
  transport.emitClose({ code: 1011, reason: 'upstream reset', wasClean: false });

  assert.equal(reconnectScheduler.scheduled.length, 0);
  const closeLog = logs.find((entry) => entry.message === 'gateway.close');
  assert.equal(closeLog?.meta?.reconnectPlanned, false);
});

test('register_rejected emits non-retryable structured error and disconnects', async () => {
  FakeWebSocket.instances = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  ws.emitMessage({ type: 'register_rejected', reason: 'duplicate_connection' });
  await assert.rejects(
    connecting,
    (error) => error instanceof GatewayClientError && error.code === 'GATEWAY_HANDSHAKE_REJECTED',
  );
  await flushAsyncHandlers();

  assert.equal(client.getStatus().isClosed(), true);
  assert.equal(client.getStatus().getError()?.code, 'GATEWAY_HANDSHAKE_REJECTED');
});
