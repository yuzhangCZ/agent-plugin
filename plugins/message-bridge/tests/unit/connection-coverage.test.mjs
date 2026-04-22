import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createGatewayClient } from '@agent-plugin/gateway-client';

class ScriptedWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  static scripts = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.script = ScriptedWebSocket.scripts.shift() ?? { open: true };
    ScriptedWebSocket.instances.push(this);

    setTimeout(() => {
      if (this.script.errorOnOpen) {
        this.onerror?.(this.script.errorEvent ?? new Error('socket error'));
        if (this.script.closeAfterError !== false) {
          this.readyState = ScriptedWebSocket.CLOSED;
          this.onclose?.(this.script.closeEvent);
        }
        return;
      }
      if (this.script.closeBeforeOpen) {
        this.readyState = ScriptedWebSocket.CLOSED;
        this.onclose?.();
        return;
      }
      this.readyState = ScriptedWebSocket.OPEN;
      this.onopen?.();
      if (this.script.autoRegisterOk !== false) {
        const emitRegisterOk = () => {
          this.onmessage?.({ data: JSON.stringify({ type: 'register_ok' }) });
        };
        if (this.script.registerOkDelayMs !== undefined) {
          setTimeout(emitRegisterOk, this.script.registerOkDelayMs);
        } else {
          emitRegisterOk();
        }
      }
      if (this.script.closeAfterOpenMs !== undefined) {
        setTimeout(() => {
          this.readyState = ScriptedWebSocket.CLOSED;
          this.onclose?.(this.script.closeEvent ?? {
            code: this.script.closeCode,
            reason: this.script.closeReason,
            wasClean: this.script.wasClean,
          });
        }, this.script.closeAfterOpenMs);
      }
    }, this.script.openDelayMs ?? 0);
  }

  send(raw) {
    if (this.script.sendThrows) {
      throw new Error('send failed');
    }
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.readyState = ScriptedWebSocket.CLOSED;
    this.onclose?.();
  }

  emitMessage(data) {
    this.onmessage?.({ data });
  }
}

function registerMessage() {
  return {
    type: 'register',
    deviceName: 'dev',
    macAddress: 'aa:bb:cc:dd:ee:ff',
    os: 'darwin',
    toolType: 'channel',
    toolVersion: '1.0.0',
  };
}

function reconnectConfig(overrides = {}) {
  return {
    baseMs: 1000,
    maxMs: 30000,
    exponential: true,
    jitter: 'full',
    maxElapsedMs: 600000,
    ...overrides,
  };
}

function createLoggerRecorder() {
  const entries = [];
  const logger = {
    debug(message, extra) {
      entries.push({ level: 'debug', message, extra });
    },
    info(message, extra) {
      entries.push({ level: 'info', message, extra });
    },
    warn(message, extra) {
      entries.push({ level: 'warn', message, extra });
    },
    error(message, extra) {
      entries.push({ level: 'error', message, extra });
    },
    child() {
      return logger;
    },
    getTraceId() {
      return 'runtime-trace-1';
    },
  };

  return { logger, entries };
}

function createMessagePartUpdatedToolEventMessage({
  toolSessionId,
  messageId = 'op-msg-1',
  partId = 'part-1',
  text = 'hello',
}) {
  return {
    type: 'tool_event',
    toolSessionId,
    event: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: partId,
          sessionID: toolSessionId,
          messageID: messageId,
          type: 'text',
          text,
        },
      },
    },
  };
}

function createMessageUpdatedToolEventMessage({
  toolSessionId,
  messageId = 'msg-1',
  finishReason,
}) {
  return {
    type: 'tool_event',
    toolSessionId,
    event: {
      type: 'message.updated',
      properties: {
        info: {
          id: messageId,
          sessionID: toolSessionId,
          role: 'assistant',
          time: { created: 1 },
          ...(finishReason ? { finish: { reason: finishReason } } : {}),
        },
      },
    },
  };
}

function createSessionUpdatedToolEventMessage(toolSessionId) {
  return {
    type: 'tool_event',
    toolSessionId,
    event: {
      type: 'session.updated',
      properties: {
        sessionID: toolSessionId,
        info: {
          id: toolSessionId,
        },
      },
    },
  };
}

function createSessionStatusToolEventMessage(toolSessionId) {
  return {
    type: 'tool_event',
    toolSessionId,
    event: {
      type: 'session.status',
      properties: {
        sessionID: toolSessionId,
        status: {
          type: 'busy',
        },
      },
    },
  };
}

function waitForReady(conn, states, timeoutMs = 200) {
  if (conn.getState() === 'READY') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.off('stateChange', handleStateChange);
      reject(
        new Error(
          `Timed out waiting for READY: state=${conn.getState()} websocketInstances=${ScriptedWebSocket.instances.length} states=${states.join(' -> ')}`,
        ),
      );
    }, timeoutMs);

    const handleStateChange = (state) => {
      if (state !== 'READY') {
        return;
      }

      clearTimeout(timeout);
      conn.off('stateChange', handleStateChange);
      resolve();
    };

    conn.on('stateChange', handleStateChange);
  });
}

function waitForState(conn, states, expectedState, timeoutMs = 200) {
  if (conn.getState() === expectedState) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.off('stateChange', handleStateChange);
      reject(
        new Error(
          `Timed out waiting for ${expectedState}: state=${conn.getState()} websocketInstances=${ScriptedWebSocket.instances.length} states=${states.join(' -> ')}`,
        ),
      );
    }, timeoutMs);

    const handleStateChange = (state) => {
      if (state !== expectedState) {
        return;
      }

      clearTimeout(timeout);
      conn.off('stateChange', handleStateChange);
      resolve();
    };

    conn.on('stateChange', handleStateChange);
  });
}

describe('DefaultGatewayConnection coverage', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    ScriptedWebSocket.instances = [];
    ScriptedWebSocket.scripts = [];
    globalThis.WebSocket = ScriptedWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  test('rejects on aborted signal before connect', async () => {
    const controller = new AbortController();
    controller.abort();
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      abortSignal: controller.signal,
      registerMessage: registerMessage(),
    });
    await assert.rejects(conn.connect());
    assert.strictEqual(conn.getState(), 'DISCONNECTED');
  });

  test('connect/disconnect lifecycle and send guard', async () => {
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      heartbeatIntervalMs: 5,
      registerMessage: registerMessage(),
    });
    await conn.connect();
    assert.strictEqual(conn.getState(), 'READY');
    assert.strictEqual(conn.isConnected(), true);

    assert.doesNotThrow(() => conn.send({ type: 'tool_done', toolSessionId: 'tool-1', welinkSessionId: 'wl-1' }));
    conn.disconnect();
    assert.strictEqual(conn.getState(), 'DISCONNECTED');
    assert.throws(() => conn.send({ type: 'tool_done', toolSessionId: 'tool-1', welinkSessionId: 'wl-1' }), /gateway_not_connected/);
  });

  test('connect rejects invalid register control messages before sending', async () => {
    const { logger, entries } = createLoggerRecorder();
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: {
        type: 'register',
        deviceName: '   ',
        macAddress: 'aa:bb:cc:dd:ee:ff',
        os: 'darwin',
        toolType: 'channel',
        toolVersion: '1.0.0',
      },
      logger,
    });

    await assert.rejects(conn.connect(), /deviceName is required/);
    assert.strictEqual(entries.some((entry) => entry.message === 'gateway.register.failed'), true);
    assert.deepStrictEqual(ScriptedWebSocket.instances[0]?.sent ?? [], []);
  });

  test('send rejects invalid heartbeat control messages', async () => {
    const { logger, entries } = createLoggerRecorder();
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger,
    });

    await conn.connect();

    assert.throws(
      () =>
        conn.send({
          type: 'heartbeat',
          timestamp: '',
        }),
      /gateway_invalid_message_type:heartbeat/,
    );
    assert.strictEqual(
      entries.some((entry) => entry.message === 'gateway.send' && entry.extra?.messageType === 'heartbeat'),
      false,
    );
  });

  test('passes gateway auth via websocket subprotocol instead of query params', async () => {
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      authPayloadProvider: () => ({
        ak: 'test-ak-001',
        ts: '1700000000',
        nonce: 'nonce-001',
        sign: 'sig+/=',
      }),
      registerMessage: registerMessage(),
    });

    await conn.connect();

    const ws = ScriptedWebSocket.instances[0];
    assert.strictEqual(ws.url, 'ws://localhost:8081/ws/agent');
    assert.strictEqual(ws.protocols.length, 1);
    assert.ok(ws.protocols[0].startsWith('auth.'));

    const encoded = ws.protocols[0].slice('auth.'.length);
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    assert.deepStrictEqual(decoded, {
      ak: 'test-ak-001',
      ts: '1700000000',
      nonce: 'nonce-001',
      sign: 'sig+/=',
    });

    conn.disconnect();
  });

  test('waits for register_ok before entering READY', async () => {
    ScriptedWebSocket.scripts.push({ autoRegisterOk: false });
    const states = [];
    const messages = [];
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    });
    conn.on('stateChange', (state) => states.push(state));
    conn.on('message', (message) => messages.push(message));

    const connecting = conn.connect();
    await new Promise((r) => setTimeout(r, 0));

    const ws = ScriptedWebSocket.instances[0];
    assert.strictEqual(conn.getState(), 'CONNECTED');
    const outboundRegister = ws.sent.find((entry) => entry.type === 'register');
    assert.deepStrictEqual(outboundRegister, registerMessage());
    assert.throws(() => conn.send({ type: 'tool_event', payload: 1 }));

    ws.emitMessage(JSON.stringify({ type: 'invoke', action: 'chat', payload: { toolSessionId: 's-1', text: 'hi' } }));
    assert.deepStrictEqual(messages, []);

    ws.emitMessage(JSON.stringify({ type: 'register_ok' }));
    await connecting;

    assert.strictEqual(conn.getState(), 'READY');
    assert.deepStrictEqual(states, ['CONNECTING', 'CONNECTED', 'READY']);

    conn.disconnect();
  });

  test('closes on register_rejected and never becomes READY', async () => {
    ScriptedWebSocket.scripts.push({ autoRegisterOk: false });
    const { logger, entries } = createLoggerRecorder();
    const states = [];
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger,
    });
    conn.on('stateChange', (state) => states.push(state));

    const connecting = conn.connect();
    await new Promise((r) => setTimeout(r, 0));

    const ws = ScriptedWebSocket.instances[0];
    ws.emitMessage(JSON.stringify({ type: 'register_rejected', reason: 'device_conflict' }));
    await assert.rejects(connecting);

    assert.strictEqual(conn.getState(), 'DISCONNECTED');
    assert.deepStrictEqual(states, ['CONNECTING', 'CONNECTED', 'DISCONNECTED']);
    assert.ok(entries.some(e => JSON.stringify(e) === JSON.stringify({
      level: 'error',
      message: 'gateway.register.rejected',
      extra: { reason: 'device_conflict' },
    })));
    conn.disconnect();
  });

  test('does not reset reconnect policy when websocket opens but never reaches READY', async () => {
    ScriptedWebSocket.scripts.push({ autoRegisterOk: false, closeAfterOpenMs: 0 });
    let resetCalls = 0;
    const reconnectPolicy = {
      reset() {
        resetCalls += 1;
      },
      startWindow() {},
      scheduleNextAttempt() {
        return {
          ok: false,
          elapsedMs: 0,
          maxElapsedMs: 1,
        };
      },
      getExhaustedDecision() {
        return {
          ok: false,
          elapsedMs: 0,
          maxElapsedMs: 1,
        };
      },
    };

    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      reconnectPolicy,
      registerMessage: registerMessage(),
    });

    await assert.rejects(conn.connect());
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(conn.getState(), 'DISCONNECTED');
    assert.strictEqual(resetCalls, 0);
    conn.disconnect();
  });

  test('rejects on invalid url and websocket error', async () => {
    const badUrl = createGatewayClient({
      url: 'not-a-valid-url',
      registerMessage: registerMessage(),
    });
    await assert.rejects(badUrl.connect());

    ScriptedWebSocket.scripts.push({ errorOnOpen: true });
    const errorConn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    });
    errorConn.on('error', () => {});
    await assert.rejects(errorConn.connect());
    errorConn.disconnect();
    badUrl.disconnect();
  });

  test('logs websocket error details when the runtime provides them', async () => {
    const errorLogs = [];
    ScriptedWebSocket.scripts.push({ errorOnOpen: true });
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger: {
        debug() {},
        info() {},
        warn() {},
        error(message, extra) {
          errorLogs.push({ message, extra });
        },
        child() {
          return this;
        },
        getTraceId() {
          return 'trace-test';
        },
      },
    });
    conn.on('error', () => {});

    await assert.rejects(conn.connect());

    assert.ok(errorLogs.some((entry) =>
      entry.message === 'gateway.error'
      && entry.extra?.error === 'gateway_websocket_error'
      && entry.extra?.errorDetail === 'socket error'
      && entry.extra?.errorType === 'Error'
      && entry.extra?.rawType === 'Error',
    ));
    conn.disconnect();
  });

  test('logs websocket event metadata when onerror receives an event object', async () => {
    const errorLogs = [];
    ScriptedWebSocket.scripts.push({
      errorOnOpen: true,
      errorEvent: {
        type: 'error',
        message: 'socket error',
        target: { readyState: 0 },
      },
    });
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger: {
        debug() {},
        info() {},
        warn() {},
        error(message, extra) {
          errorLogs.push({ message, extra });
        },
        child() {
          return this;
        },
        getTraceId() {
          return 'trace-test';
        },
      },
    });
    conn.on('error', () => {});

    await assert.rejects(conn.connect());

    assert.ok(errorLogs.some((entry) =>
      entry.message === 'gateway.error'
      && entry.extra?.error === 'gateway_websocket_error'
      && entry.extra?.errorDetail === 'socket error'
      && entry.extra?.errorType === 'error'
      && entry.extra?.rawType === 'Object'
      && entry.extra?.eventType === 'error'
      && entry.extra?.readyState === 0,
    ));
    conn.disconnect();
  });

  test('reconnects after opened connection closes unexpectedly', async () => {
    ScriptedWebSocket.scripts.push({ closeAfterOpenMs: 10, closeCode: 1013 }, { open: true });
    const states = [];
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      reconnect: reconnectConfig({ baseMs: 5, maxMs: 5, jitter: 'none' }),
      registerMessage: registerMessage(),
    });
    conn.on('stateChange', (state) => states.push(state));
    await conn.connect();
    states.length = 0;
    await waitForState(conn, states, 'DISCONNECTED');
    await waitForReady(conn, states);
    assert.ok(ScriptedWebSocket.instances.length >= 2);
    conn.disconnect();
  });

  for (const closeCode of [4403, 4408, 4409]) {
    test(`does not reconnect on gateway rejection close code ${closeCode}`, async () => {
      const { logger, entries } = createLoggerRecorder();
      ScriptedWebSocket.scripts.push({
        closeAfterOpenMs: 0,
        closeCode,
        closeReason: `rejected-${closeCode}`,
        wasClean: true,
      });
      const conn = createGatewayClient({
        url: 'ws://localhost:8081/ws/agent',
        reconnect: reconnectConfig({ baseMs: 5, maxMs: 5, jitter: 'none' }),
        registerMessage: registerMessage(),
        logger,
      });

      await conn.connect();
      await new Promise((r) => setTimeout(r, 30));

      assert.strictEqual(ScriptedWebSocket.instances.length, 1);
      assert.strictEqual(conn.getState(), 'DISCONNECTED');
      assert.ok(entries.some(e => JSON.stringify(e) === JSON.stringify({
        level: 'warn',
        message: 'gateway.close.rejected',
        extra: {
          code: closeCode,
          reason: `rejected-${closeCode}`,
          rejected: true,
        },
      })));
      conn.disconnect();
    });
  }

  test('does not reconnect when aborted after open', async () => {
    const controller = new AbortController();
    ScriptedWebSocket.scripts.push({ open: true });
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      reconnect: reconnectConfig({ baseMs: 5, maxMs: 5, jitter: 'none' }),
      abortSignal: controller.signal,
      registerMessage: registerMessage(),
    });
    await conn.connect();
    controller.abort();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(ScriptedWebSocket.instances.length, 1);
    assert.strictEqual(conn.getState(), 'READY');
    conn.disconnect();
  });

  test('emits structured inbound frames and ignores invalid business payloads', async () => {
    const inbound = [];
    const messages = [];
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
    });
    conn.on('inbound', (frame) => inbound.push(frame));
    conn.on('message', (msg) => messages.push(msg));
    await conn.connect();

    const ws = ScriptedWebSocket.instances[0];
    ws.emitMessage('{"type":"status_query"}');
    ws.emitMessage('{"x":1}');
    ws.emitMessage(new Uint8Array([123, 34, 121, 34, 58, 50, 125])); // {"y":2}
    ws.emitMessage(Uint8Array.from([123, 34, 122, 34, 58, 51, 125]).buffer); // {"z":3}
    ws.emitMessage(new Blob(['{"k":4}']));
    ws.emitMessage('not-json');
    await new Promise((r) => setTimeout(r, 10));

    assert.deepStrictEqual(messages, [{ type: 'status_query' }]);
    assert.deepStrictEqual(
      inbound.map((frame) => frame.kind),
      ['control', 'business', 'invalid', 'decode_error', 'decode_error', 'decode_error', 'parse_error'],
    );
    assert.strictEqual(inbound[2].messageType, 'unknown');
    assert.deepStrictEqual(inbound[2].rawPreview, { x: 1 });
    assert.strictEqual(inbound.at(-1).rawPreview, 'not-json');
    conn.disconnect();
  });

  test('logs payload bytes and message ids when sending', async () => {
    const { logger, entries } = createLoggerRecorder();
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger,
    });
    await conn.connect();

    conn.send(
      createMessagePartUpdatedToolEventMessage({
        toolSessionId: 'tool-1',
        messageId: 'op-msg-1',
        partId: 'part-1',
      }),
      {
        traceId: 'bridge-1',
        runtimeTraceId: 'runtime-trace-1',
        bridgeMessageId: 'bridge-1',
        sessionId: 'skill-1',
        toolSessionId: 'tool-1',
        eventType: 'message.part.updated',
        opencodeMessageId: 'op-msg-1',
        opencodePartId: 'part-1',
      },
    );

    const sendLog = entries.find(
      (entry) => entry.message === 'gateway.send' && entry.extra.traceId === 'bridge-1',
    );
    assert.notStrictEqual(sendLog, undefined);
    assert.strictEqual(sendLog.extra.messageType, 'tool_event');
    assert.ok(sendLog.extra.payloadBytes > 0);
    assert.strictEqual(sendLog.extra.traceId, 'bridge-1');
    assert.strictEqual('bridgeMessageId' in sendLog.extra, false);
    assert.strictEqual(sendLog.extra.opencodeMessageId, 'op-msg-1');
    assert.strictEqual(sendLog.extra.opencodePartId, 'part-1');
    assert.strictEqual(sendLog.extra.eventType, 'message.part.updated');

    conn.disconnect();
  });

  test('emits readable raw websocket frame logs at info level when debug is enabled', async () => {
    const { logger, entries } = createLoggerRecorder();
    ScriptedWebSocket.scripts.push({
      autoRegisterOk: false,
      errorOnOpen: true,
      errorEvent: {
        type: 'error',
        message: 'socket error',
        target: { readyState: 0 },
      },
    });

    const connectFailingConn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      debug: true,
      registerMessage: registerMessage(),
      logger,
    });
    connectFailingConn.on('error', () => {});
    await assert.rejects(connectFailingConn.connect());

    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      debug: true,
      registerMessage: registerMessage(),
      logger,
    });
    await conn.connect();

    const ws = ScriptedWebSocket.instances.at(-1);
    ws.emitMessage(JSON.stringify({ type: 'invoke', action: 'chat', payload: { toolSessionId: 's-1', text: 'hi' } }));
    await new Promise((r) => setTimeout(r, 10));

    const rawOpenLog = entries.find((entry) => entry.level === 'info' && entry.message.startsWith('「onOpen」===>「'));
    const rawSendLog = entries.find(
      (entry) => entry.level === 'info' && entry.message.includes('「sendMessage」===>「{"type":"register"'),
    );
    const rawMessageLog = entries.find(
      (entry) => entry.level === 'info' && entry.message.includes('「onMessage」===>「{"type":"invoke"'),
    );
    const rawErrorLog = entries.find(
      (entry) => entry.level === 'info' && entry.message.includes('「onError」===>「{"type":"error","message":"socket error"'),
    );

    assert.notStrictEqual(rawOpenLog, undefined);
    assert.notStrictEqual(rawSendLog, undefined);
    assert.notStrictEqual(rawMessageLog, undefined);
    assert.notStrictEqual(rawErrorLog, undefined);

    conn.disconnect();
    connectFailingConn.disconnect();
  });

  test('does not emit raw websocket frame logs when debug is disabled', async () => {
    const { logger, entries } = createLoggerRecorder();
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      debug: false,
      registerMessage: registerMessage(),
      logger,
    });
    await conn.connect();

    const ws = ScriptedWebSocket.instances[0];
    ws.emitMessage(JSON.stringify({ type: 'invoke', action: 'chat', payload: { toolSessionId: 's-1', text: 'hi' } }));
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(entries.some((entry) => entry.message === 'gateway.send'));
    assert.ok(entries.some((entry) => entry.message === 'gateway.message.received'));
    assert.strictEqual(entries.some((entry) => typeof entry.message === 'string' && entry.message.startsWith('「on')), false);
    assert.strictEqual(entries.some((entry) => entry.message === '「sendMessage」===>「{"type":"register","deviceName":"dev","macAddress":"aa:bb:cc:dd:ee:ff","os":"darwin","toolType":"channel","toolVersion":"1.0.0"}」'), false);

    conn.disconnect();
  });

  test('logs frame bytes and gatewayMessageId for received frames', async () => {
    const { logger, entries } = createLoggerRecorder();
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger,
    });
    await conn.connect();

    const ws = ScriptedWebSocket.instances[0];
    ws.emitMessage(
      JSON.stringify({
        messageId: 'gw-1',
        type: 'invoke',
        action: 'chat',
        welinkSessionId: 'skill-1',
        payload: { toolSessionId: 'tool-1', text: 'hello' },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    const receivedLog = [...entries].reverse().find(
      (entry) => entry.message === 'gateway.message.received' && entry.extra.messageType === 'invoke',
    );
    assert.notStrictEqual(receivedLog, undefined);
    assert.strictEqual(receivedLog.extra.messageType, 'invoke');
    assert.strictEqual(receivedLog.extra.gatewayMessageId, 'gw-1');
    assert.ok(receivedLog.extra.frameBytes > 0);

    conn.disconnect();
  });

  test('logs minimal last-message summary on close', async () => {
    const { logger, entries } = createLoggerRecorder();
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger,
    });
    await conn.connect();

    const lastMessage = createMessageUpdatedToolEventMessage({
      toolSessionId: 'tool-last-1',
      messageId: 'op-msg-last-1',
    });
    conn.send(
      lastMessage,
      {
        traceId: 'bridge-last-1',
        runtimeTraceId: 'runtime-trace-1',
        bridgeMessageId: 'bridge-last-1',
        toolSessionId: 'tool-last-1',
        eventType: 'message.updated',
        opencodeMessageId: 'op-msg-last-1',
      },
    );
    conn.disconnect();

    const closeLog = entries.find((entry) => entry.message === 'gateway.close');
    assert.notStrictEqual(closeLog, undefined);
    assert.strictEqual(closeLog.extra.lastMessageDirection, 'sent');
    assert.strictEqual(closeLog.extra.lastMessageType, 'tool_event');
    assert.strictEqual(closeLog.extra.lastMessageId, 'bridge-last-1');
    assert.ok(closeLog.extra.lastPayloadBytes > 0);
    assert.strictEqual(closeLog.extra.lastEventType, 'message.updated');
    assert.strictEqual(closeLog.extra.lastOpencodeMessageId, 'op-msg-last-1');
    assert.deepStrictEqual(closeLog.extra.recentOutboundMessages, [
      {
        eventType: 'message.updated',
        toolSessionId: 'tool-last-1',
        opencodeMessageId: 'op-msg-last-1',
        payloadBytes: Buffer.byteLength(JSON.stringify(lastMessage), 'utf8'),
      },
    ]);
  });

  test('keeps only the latest three outbound message summaries in close logs', async () => {
    const { logger, entries } = createLoggerRecorder();
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger,
    });
    await conn.connect();

    for (const [index, eventType] of ['message.updated', 'session.updated', 'session.status'].entries()) {
      const toolSessionId = `tool-${index}`;
      const message =
        eventType === 'message.updated'
          ? createMessageUpdatedToolEventMessage({ toolSessionId, messageId: `op-msg-${index}` })
          : eventType === 'session.updated'
            ? createSessionUpdatedToolEventMessage(toolSessionId)
            : createSessionStatusToolEventMessage(toolSessionId);
      conn.send(
        message,
        {
          traceId: `bridge-${index}`,
          gatewayMessageId: `bridge-${index}`,
          toolSessionId,
          eventType,
          opencodeMessageId: `op-msg-${index}`,
        },
      );
    }
    conn.disconnect();

    const closeLog = entries.find((entry) => entry.message === 'gateway.close');
    assert.notStrictEqual(closeLog, undefined);
    assert.deepStrictEqual(closeLog.extra.recentOutboundMessages, [
      {
        eventType: 'message.updated',
        toolSessionId: 'tool-0',
        opencodeMessageId: 'op-msg-0',
        payloadBytes: Buffer.byteLength(
          JSON.stringify(createMessageUpdatedToolEventMessage({ toolSessionId: 'tool-0', messageId: 'op-msg-0' })),
          'utf8',
        ),
      },
      {
        eventType: 'session.updated',
        toolSessionId: 'tool-1',
        opencodeMessageId: 'op-msg-1',
        payloadBytes: Buffer.byteLength(JSON.stringify(createSessionUpdatedToolEventMessage('tool-1')), 'utf8'),
      },
      {
        eventType: 'session.status',
        toolSessionId: 'tool-2',
        opencodeMessageId: 'op-msg-2',
        payloadBytes: Buffer.byteLength(JSON.stringify(createSessionStatusToolEventMessage('tool-2')), 'utf8'),
      },
    ]);
  });

  test('warns when outbound payload exceeds the large payload threshold', async () => {
    const { logger, entries } = createLoggerRecorder();
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger,
    });
    await conn.connect();

    conn.send(
      {
        type: 'tool_event',
        toolSessionId: 'tool-large',
        event: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg-large',
              sessionID: 'tool-large',
              role: 'assistant',
              time: { created: 1 },
              finish: { reason: 'x'.repeat(1024 * 1024) },
            },
          },
        },
      },
      {
        traceId: 'bridge-large',
        gatewayMessageId: 'bridge-large',
        toolSessionId: 'tool-large',
        eventType: 'message.updated',
        opencodeMessageId: 'op-msg-large',
      },
    );

    const warnLog = entries.find((entry) => entry.message === 'gateway.send.large_payload');
    assert.notStrictEqual(warnLog, undefined);
    assert.strictEqual(warnLog.extra.eventType, 'message.updated');
    assert.strictEqual(warnLog.extra.toolSessionId, 'tool-large');
    assert.strictEqual(warnLog.extra.opencodeMessageId, 'op-msg-large');
    assert.ok(warnLog.extra.payloadBytes >= 1024 * 1024);
  });

  test('excludes control messages from recent outbound summaries', async () => {
    const { logger, entries } = createLoggerRecorder();
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: registerMessage(),
      logger,
    });
    await conn.connect();

    conn.send(
      {
        type: 'tool_event',
        toolSessionId: 'tool-business-1',
        event: {
          type: 'session.updated',
          properties: {
            sessionID: 'tool-business-1',
            info: {
              id: 'tool-business-1',
            },
          },
        },
      },
      {
        gatewayMessageId: 'business-1',
        toolSessionId: 'tool-business-1',
        eventType: 'session.updated',
        opencodeMessageId: 'op-msg-business-1',
      },
    );
    conn.disconnect();

    const closeLog = entries.find((entry) => entry.message === 'gateway.close');
    assert.notStrictEqual(closeLog, undefined);
    assert.deepStrictEqual(closeLog.extra.recentOutboundMessages, [
      {
        eventType: 'session.updated',
        toolSessionId: 'tool-business-1',
        opencodeMessageId: 'op-msg-business-1',
        payloadBytes: Buffer.byteLength(
          JSON.stringify({
            type: 'tool_event',
            toolSessionId: 'tool-business-1',
            event: {
              type: 'session.updated',
              properties: {
                sessionID: 'tool-business-1',
                info: {
                  id: 'tool-business-1',
                },
              },
            },
          }),
          'utf8',
        ),
      },
    ]);
  });

  test('clears outbound summaries before an automatic reconnect', async () => {
    const { logger, entries } = createLoggerRecorder();
    const states = [];
    ScriptedWebSocket.scripts.push(
      { closeAfterOpenMs: 10, closeCode: 1013, closeReason: 'retry-later', wasClean: false },
      { open: true },
    );
    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      reconnect: reconnectConfig({ baseMs: 5, maxMs: 5, jitter: 'none' }),
      registerMessage: registerMessage(),
      logger,
    });
    conn.on('stateChange', (state) => states.push(state));

    await conn.connect();
    states.length = 0;
    conn.send(
      {
        type: 'tool_event',
        toolSessionId: 'tool-before',
        event: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg-before',
              sessionID: 'tool-before',
              role: 'assistant',
              time: { created: 1 },
            },
          },
        },
      },
      {
        gatewayMessageId: 'before-reconnect',
        toolSessionId: 'tool-before',
        eventType: 'message.updated',
        opencodeMessageId: 'op-msg-before',
      },
    );

    await waitForState(conn, states, 'DISCONNECTED');
    await waitForReady(conn, states);

    conn.send(
      {
        type: 'tool_event',
        toolSessionId: 'tool-after',
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'tool-after',
            status: {
              type: 'busy',
            },
          },
        },
      },
      {
        gatewayMessageId: 'after-reconnect',
        toolSessionId: 'tool-after',
        eventType: 'session.status',
        opencodeMessageId: 'op-msg-after',
      },
    );
    conn.disconnect();

    const closeLogs = entries.filter((entry) => entry.message === 'gateway.close');
    assert.ok(closeLogs.length >= 2);
    const finalCloseLog = closeLogs.at(-1);
    assert.notStrictEqual(finalCloseLog, undefined);
    assert.deepStrictEqual(finalCloseLog.extra.recentOutboundMessages, [
      {
        eventType: 'session.status',
        toolSessionId: 'tool-after',
        opencodeMessageId: 'op-msg-after',
        payloadBytes: Buffer.byteLength(
          JSON.stringify({
            type: 'tool_event',
            toolSessionId: 'tool-after',
            event: {
              type: 'session.status',
              properties: {
                sessionID: 'tool-after',
                status: {
                  type: 'busy',
                },
              },
            },
          }),
          'utf8',
        ),
      },
    ]);
  });

  test('logs reconnect exhaustion and stops before opening a new socket', async () => {
    const { logger, entries } = createLoggerRecorder();
    ScriptedWebSocket.scripts.push({ closeAfterOpenMs: 10, closeCode: 1013 });

    const reconnectPolicy = {
      reset() {},
      startWindow() {},
      scheduleNextAttempt() {
        return {
          ok: true,
          attempt: 1,
          delayMs: 0,
          elapsedMs: 0,
        };
      },
      getExhaustedDecision() {
        return {
          ok: false,
          elapsedMs: 10,
          maxElapsedMs: 10,
        };
      },
    };

    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      reconnectPolicy,
      registerMessage: registerMessage(),
      logger,
    });

    await conn.connect();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(ScriptedWebSocket.instances.length, 1);
    assert.ok(entries.some((entry) => entry.message === 'gateway.reconnect.exhausted'));
    conn.disconnect();
  });

  test('stops immediately when the next retry would exceed the remaining reconnect budget', async () => {
    const { logger, entries } = createLoggerRecorder();
    ScriptedWebSocket.scripts.push({ closeAfterOpenMs: 10, closeCode: 1013 });

    const conn = createGatewayClient({
      url: 'ws://localhost:8081/ws/agent',
      reconnect: reconnectConfig({ baseMs: 20, maxMs: 20, jitter: 'none', maxElapsedMs: 5 }),
      registerMessage: registerMessage(),
      logger,
    });

    await conn.connect();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(ScriptedWebSocket.instances.length, 1);
    assert.ok(entries.some((entry) => entry.message === 'gateway.reconnect.exhausted'));
    assert.strictEqual(entries.some((entry) => entry.message === 'gateway.reconnect.scheduled'), false);
    conn.disconnect();
  });
});
