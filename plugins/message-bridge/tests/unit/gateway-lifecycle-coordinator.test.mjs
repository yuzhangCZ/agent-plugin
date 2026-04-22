import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultGatewayLifecycleCoordinator } from '../../src/runtime/GatewayLifecycleCoordinator.ts';

function createPortRecorder() {
  const recorder = {
    states: [],
    errors: [],
    inbound: [],
    messages: [],
    logs: [],
    port: {
      publishState(state) {
        recorder.states.push(state);
      },
      publishError(error) {
        recorder.errors.push(error);
      },
      handleInbound(frame) {
        recorder.inbound.push(frame);
      },
      handleMessage(message) {
        recorder.messages.push(message);
      },
      log(level, message, meta) {
        recorder.logs.push({ level, message, meta });
      },
    },
  };
  return recorder;
}

function createEventedConnection(state = 'DISCONNECTED', options = {}) {
  let currentState = state;
  const listeners = new Map();
  let connectResolve;
  let connectReject;
  const connectPromise = options.controlledConnect
    ? new Promise((resolve, reject) => {
        connectResolve = resolve;
        connectReject = reject;
      })
    : Promise.resolve();
  const connection = {
    disconnectCount: 0,
    getState: () => currentState,
    getStatus: () => ({
      isReady: () => currentState === 'READY',
    }),
    connect: () => connectPromise,
    disconnect: () => {
      connection.disconnectCount += 1;
    },
    send: () => undefined,
    on: (event, listener) => {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    },
    emit: (event, payload) => {
      if (event === 'stateChange') {
        currentState = payload;
      }
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
    resolveConnect: () => {
      connectResolve?.();
    },
    rejectConnect: (error) => {
      connectReject?.(error);
    },
  };

  if (options.withOff !== false) {
    connection.off = (event, listener) => {
      const current = listeners.get(event) ?? [];
      listeners.set(event, current.filter((candidate) => candidate !== listener));
    };
  }

  return connection;
}

describe('gateway lifecycle coordinator', () => {
  test('stopSession ignores stale state, error, inbound, and message events', async () => {
    const recorder = createPortRecorder();
    const coordinator = new DefaultGatewayLifecycleCoordinator(recorder.port);
    const connection = createEventedConnection();

    await coordinator.startSession(connection);
    connection.emit('stateChange', 'READY');
    connection.emit('error', { message: 'before stop' });
    connection.emit('inbound', { type: 'invoke' });
    connection.emit('message', { type: 'status_query' });

    assert.equal(recorder.states.length, 1);
    assert.equal(recorder.errors.length, 1);
    assert.equal(recorder.inbound.length, 1);
    assert.equal(recorder.messages.length, 1);

    coordinator.stopSession();
    connection.emit('stateChange', 'READY');
    connection.emit('error', { message: 'after stop' });
    connection.emit('inbound', { type: 'invoke' });
    connection.emit('message', { type: 'status_query' });

    assert.equal(recorder.states.length, 1);
    assert.equal(recorder.errors.length, 1);
    assert.equal(recorder.inbound.length, 1);
    assert.equal(recorder.messages.length, 1);
  });

  test('replace ignores late events from previous session and cancels prior start promise', async () => {
    const recorder = createPortRecorder();
    const coordinator = new DefaultGatewayLifecycleCoordinator(recorder.port);
    const first = createEventedConnection('DISCONNECTED', { controlledConnect: true });
    const second = createEventedConnection();

    const firstStart = coordinator.startSession(first);
    await Promise.resolve();
    await coordinator.startSession(second);

    first.emit('stateChange', 'READY');
    first.emit('error', { message: 'stale error' });
    first.emit('inbound', { type: 'invoke', source: 'stale' });
    first.emit('message', { type: 'status_query', source: 'stale' });

    assert.equal(recorder.states.length, 0);
    assert.equal(recorder.errors.length, 0);
    assert.equal(recorder.inbound.length, 0);
    assert.equal(recorder.messages.length, 0);

    second.emit('stateChange', 'READY');
    second.emit('error', { message: 'active error' });
    second.emit('inbound', { type: 'invoke', source: 'active' });
    second.emit('message', { type: 'status_query', source: 'active' });

    assert.equal(recorder.states.length, 1);
    assert.equal(recorder.errors.length, 1);
    assert.equal(recorder.inbound.length, 1);
    assert.equal(recorder.messages.length, 1);

    first.resolveConnect();
    await assert.rejects(firstStart, /runtime_start_aborted/);
  });

  test('token guard still works when connection does not support off/removeListener', async () => {
    const recorder = createPortRecorder();
    const coordinator = new DefaultGatewayLifecycleCoordinator(recorder.port);
    const connection = createEventedConnection('DISCONNECTED', { withOff: false });

    await coordinator.startSession(connection);
    coordinator.stopSession();
    connection.emit('stateChange', 'READY');
    connection.emit('error', { message: 'late error' });

    assert.equal(recorder.states.length, 0);
    assert.equal(recorder.errors.length, 0);
  });
});
