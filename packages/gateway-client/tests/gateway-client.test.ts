import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  createAkSkAuthProvider,
  createGatewayClient,
  GatewayClientError,
} from '../src/index.ts';
import { DefaultOutboundProtocolGate } from '../src/application/protocol/OutboundProtocolGate.ts';
import type { OutboundProtocolGate } from '../src/application/protocol/OutboundProtocolGate.ts';
import type { GatewayWireCodec } from '../src/ports/GatewayWireCodec.ts';
import { GatewayClientRuntime, type GatewayClientRuntimeDependencies } from '../src/application/GatewayClientRuntime.ts';
import { ControlMessageHandler } from '../src/application/handlers/ControlMessageHandler.ts';
import { BusinessMessageHandler } from '../src/application/handlers/BusinessMessageHandler.ts';
import { GatewaySchemaCodecAdapter } from '../src/adapters/GatewaySchemaCodecAdapter.ts';

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
  } as const;
}

async function flushAsyncHandlers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
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
    emitStateChange() {},
    emitInbound() {},
    emitOutbound() {},
    emitHeartbeat() {},
    emitMessage() {},
    emitError() {},
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
    controlMessageHandler: overrides.controlMessageHandler ?? new ControlMessageHandler(),
    businessMessageHandler: overrides.businessMessageHandler ?? new BusinessMessageHandler(),
    authSubprotocolBuilder: overrides.authSubprotocolBuilder ?? (() => 'auth.test'),
  };
}

class FakeReconnectPolicy {
  startWindow(): void {}
  reset(): void {}
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

  emitClose(event: { code: number; reason: string; wasClean: boolean }): void {
    this.openState = false;
    this.handlers?.onClose(event);
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
  };
}

test('connect sends register and enters READY only after register_ok', async () => {
  FakeWebSocket.instances = [];
  const states: string[] = [];
  const inbound: unknown[] = [];
  const outbound: unknown[] = [];
  const messages: unknown[] = [];

  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('stateChange', (state) => states.push(state));
  client.on('inbound', (message) => inbound.push(message));
  client.on('outbound', (message) => outbound.push(message));
  client.on('message', (message) => messages.push(message));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await connecting;

  assert.equal(client.getState(), 'CONNECTED');
  assert.deepEqual(ws.sent[0], registerMessage());
  assert.deepEqual(outbound[0], registerMessage());

  ws.emitMessage({ type: 'status_query' });
  await flushAsyncHandlers();
  assert.equal(messages.length, 0);

  ws.emitMessage({ type: 'register_ok' });
  await flushAsyncHandlers();
  assert.equal(client.getState(), 'READY');
  assert.deepEqual(inbound.at(-1), {
    kind: 'control',
    messageType: 'register_ok',
    message: { type: 'register_ok' },
  });
  assert.deepEqual(states, ['CONNECTING', 'CONNECTED', 'READY']);

  ws.emitMessage({ type: 'status_query' });
  await flushAsyncHandlers();
  assert.deepEqual(messages[0], { type: 'status_query' });
  assert.deepEqual(inbound.at(-1), {
    kind: 'business',
    messageType: 'status_query',
    message: { type: 'status_query' },
  });

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
  const errors: GatewayClientError[] = [];
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
  client.on('error', (error) => errors.push(error as GatewayClientError));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await connecting;
  ws.emitMessage({ type: 'register_ok' });
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
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, 'GATEWAY_PROTOCOL_VIOLATION');
  assert.equal(errors[0]!.retryable, false);
  assert.equal(errors[0]!.details?.stage, 'payload');
  assert.equal(errors[0]!.details?.code, 'missing_required_field');
  assert.equal(errors[0]!.details?.field, 'payload.text');
  assert.equal(errors[0]!.details?.messageType, 'invoke');
  assert.equal(errors[0]!.details?.action, 'chat');
  assert.equal(errors[0]!.details?.welinkSessionId, 'wl-invalid-1');
  assert.equal(errors[0]!.details?.toolSessionId, 'tool-1');
  assert.equal(errors[0]!.details?.gatewayMessageId, 'gw-invalid-1');
  assert.deepEqual(errors[0]!.details?.messagePreview, {
    type: 'invoke',
    keys: ['type', 'messageId', 'welinkSessionId', 'action', 'payload'],
  });
  assert.equal('rawPreview' in (errors[0]!.details ?? {}), false);
  assert.equal(logs.error[0]?.message, 'gateway.business.validation_failed');
  assert.equal(logs.error[0]?.meta?.failClosed, false);
  assert.equal(logs.error[0]?.meta?.gatewayMessageId, 'gw-invalid-1');
  assert.deepEqual(logs.error[0]?.meta?.messagePreview, {
    type: 'invoke',
    keys: ['type', 'messageId', 'welinkSessionId', 'action', 'payload'],
  });
  assert.equal('rawPreview' in (logs.error[0]?.meta ?? {}), false);
  assert.equal(client.getState(), 'READY');

  client.disconnect();
});

test('invalid control frame emits protocol error instead of being silently ignored', async () => {
  FakeWebSocket.instances = [];
  const inbound: unknown[] = [];
  const errors: GatewayClientError[] = [];
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
  client.on('error', (error) => errors.push(error as GatewayClientError));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await connecting;

  ws.emitMessage({ type: 'register_rejected', reason: 'bad-aksk' });
  await flushAsyncHandlers();

  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, 'GATEWAY_PROTOCOL_VIOLATION');
  assert.equal(errors[0]!.retryable, false);
  assert.equal(errors[0]!.details?.stage, 'transport');
  assert.equal(errors[0]!.details?.code, 'invalid_payload');
  assert.equal(errors[0]!.details?.field, 'reason');
  assert.equal(errors[0]!.details?.messageType, 'register_rejected');
  assert.equal(errors[0]!.details?.gatewayMessageId, undefined);
  assert.deepEqual(errors[0]!.details?.messagePreview, {
    type: 'register_rejected',
    keys: ['type', 'reason'],
  });
  assert.equal('rawPreview' in (errors[0]!.details ?? {}), false);
  assert.equal(logs.error[0]?.message, 'gateway.control.validation_failed');
  assert.deepEqual(logs.error[0]?.meta?.messagePreview, {
    type: 'register_rejected',
    keys: ['type', 'reason'],
  });
  assert.equal('rawPreview' in (logs.error[0]?.meta ?? {}), false);
  assert.equal(client.getState(), 'DISCONNECTED');
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
  await connecting;
  ws.emitMessage({ type: 'register_ok' });
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

  assert.equal(client.getState(), 'DISCONNECTED');
  assert.equal(client.getStatus().isReady(), false);

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await connecting;

  assert.equal(client.getState(), 'CONNECTED');
  assert.equal(client.getStatus().isReady(), false);

  ws.emitMessage({ type: 'register_ok' });
  await flushAsyncHandlers();

  assert.equal(client.getState(), 'READY');
  assert.equal(client.getStatus().isReady(), true);

  client.disconnect();
  assert.equal(client.getState(), 'DISCONNECTED');
  assert.equal(client.getStatus().isReady(), false);
});

test('default reconnect preset exhausts after maxElapsedMs and does not reconnect forever', async () => {
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
    await connecting;
    ws.emitMessage({ type: 'register_ok' });
    await flushAsyncHandlers();
    ws.emitClose({ code: 1011, reason: 'upstream reset', wasClean: false });

    assert.equal(timers.scheduled.length, 1);
    assert.equal(timers.scheduled[0]!.delay, 1_000);

    clock.nowMs = 600_001;
    assert.equal(timers.runNext(), true);
    await flushAsyncHandlers();

    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(
      logs.warn.some((entry) => entry.message === 'gateway.reconnect.exhausted'),
      true,
    );
  } finally {
    client.disconnect();
    timers.restore();
  }
});

test('unexpected close uses injected reconnect scheduler instead of runtime setTimeout', async () => {
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
    await connecting;
    ws.emitMessage({ type: 'register_ok' });
    await flushAsyncHandlers();
    ws.emitClose({ code: 1011, reason: 'upstream reset', wasClean: false });

    assert.equal(scheduler.scheduled.length, 1);
    assert.equal(scheduler.scheduled[0]!.delayMs, 1_000);
    assert.equal(timers.scheduled.length, 0);

    client.disconnect();
    assert.equal(scheduler.cancelCount > 0, true);
  } finally {
    timers.restore();
  }
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
    (error) => error instanceof GatewayClientError && error.code === 'GATEWAY_NOT_CONNECTED',
  );

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await connecting;

  assert.throws(
    () => client.send({ type: 'tool_done', toolSessionId: 'tool-1' }),
    (error) => error instanceof GatewayClientError && error.code === 'GATEWAY_NOT_READY',
  );

  client.disconnect();
});

test('public send rejects heartbeat while internal heartbeat still reaches transport through one gate', async () => {
  const transport = new FakeTransport();
  const runtime = new GatewayClientRuntime(
    { url: 'ws://localhost:8081/ws/agent', registerMessage: registerMessage() },
    buildFakeDependencies({ transport }),
    createFakeSink(),
  );

  assert.throws(() => runtime.send({ type: 'heartbeat' } as never), /GATEWAY_PROTOCOL_VIOLATION|type/i);
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
  await connecting;
  transport.emitMessage({ type: 'register_ok' });
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
      controlMessageHandler: new ControlMessageHandler(),
      businessMessageHandler: new BusinessMessageHandler(),
      authSubprotocolBuilder: () => 'auth.test',
    } satisfies GatewayClientRuntimeDependencies,
    {
      emitStateChange() {},
      emitInbound() {},
      emitOutbound() {},
      emitHeartbeat() {},
      emitMessage() {},
      emitError() {},
    },
  );

  const connecting = runtime.connect();
  transport.emitOpen();
  await connecting;
  transport.emitClose({ code: 1011, reason: 'upstream reset', wasClean: false });

  assert.equal(reconnectScheduler.scheduled.length, 0);
  const closeLog = logs.find((entry) => entry.message === 'gateway.close');
  assert.equal(closeLog?.meta?.reconnectPlanned, false);
});

test('register_rejected emits non-retryable structured error and disconnects', async () => {
  FakeWebSocket.instances = [];
  const errors: GatewayClientError[] = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    heartbeatIntervalMs: 60_000,
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });
  client.on('error', (error) => errors.push(error as GatewayClientError));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await connecting;

  ws.emitMessage({ type: 'register_rejected', reason: 'duplicate_connection' });
  await flushAsyncHandlers();

  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, 'GATEWAY_REGISTER_REJECTED');
  assert.equal(errors[0]!.retryable, false);
  assert.equal(client.getState(), 'DISCONNECTED');
});
