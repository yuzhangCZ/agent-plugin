import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateReconnectOnClose } from '../src/application/runtime/evaluateReconnectOnClose.ts';

function evaluate(
  overrides: Partial<Parameters<typeof evaluateReconnectOnClose>[0]> = {},
) {
  return evaluateReconnectOnClose({
    closeCode: 1013,
    manuallyDisconnected: false,
    aborted: false,
    reconnectEnabled: true,
    reconnectAttempt: false,
    phase: 'ready',
    ...overrides,
  });
}

test('ready whitelist close resolves to start-window', () => {
  assert.deepEqual(evaluate(), { action: 'start-window' });
});

test('reconnect attempt whitelist close resolves to continue-window', () => {
  assert.deepEqual(evaluate({
    reconnectAttempt: true,
    phase: 'register-sent',
  }), { action: 'continue-window' });
});

test('ready register-timeout close resolves to start-window', () => {
  assert.deepEqual(evaluate({ closeCode: 4408 }), { action: 'start-window' });
});

test('reconnect attempt register-timeout close resolves to continue-window', () => {
  assert.deepEqual(evaluate({
    closeCode: 4408,
    reconnectAttempt: true,
    phase: 'register-sent',
  }), { action: 'continue-window' });
});

test('manual disconnect forces stop even for whitelist close', () => {
  assert.deepEqual(evaluate({ manuallyDisconnected: true }), { action: 'stop' });
});

test('abort forces stop even for whitelist close', () => {
  assert.deepEqual(evaluate({ aborted: true }), { action: 'stop' });
});

test('disabled reconnect forces stop even for whitelist close', () => {
  assert.deepEqual(evaluate({ reconnectEnabled: false }), { action: 'stop' });
});

test('rejection close codes always resolve to stop', () => {
  for (const closeCode of [4403, 4409] as const) {
    assert.deepEqual(evaluate({ closeCode }), { action: 'stop' });
  }
});

test('non-whitelist close resolves to stop', () => {
  assert.deepEqual(evaluate({ closeCode: 1011 }), { action: 'stop' });
});

test('whitelist close outside recovery contexts resolves to stop', () => {
  assert.deepEqual(evaluate({
    reconnectAttempt: false,
    phase: 'transport-opening',
  }), { action: 'stop' });
});
