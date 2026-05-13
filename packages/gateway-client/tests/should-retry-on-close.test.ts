import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldRetryOnClose } from '../src/application/runtime/shouldRetryOnClose.ts';

function evaluate(closeCode: unknown) {
  return shouldRetryOnClose({
    closeCode,
    manuallyDisconnected: false,
    aborted: false,
  });
}

test('retryable close whitelist includes protocol register timeout close', () => {
  assert.equal(evaluate(4408), true);
});

test('rejection close codes are not retryable close whitelist members', () => {
  assert.equal(evaluate(4403), false);
  assert.equal(evaluate(4409), false);
});

test('existing transport retryable close whitelist remains unchanged', () => {
  for (const closeCode of [1006, 1012, 1013] as const) {
    assert.equal(evaluate(closeCode), true);
  }
});
