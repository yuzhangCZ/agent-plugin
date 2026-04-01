import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultReconnectPolicy } from '../../src/connection/ReconnectPolicy.ts';

function createClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    set: (value) => {
      now = value;
    },
    advance: (delta) => {
      now += delta;
    },
  };
}

describe('DefaultReconnectPolicy', () => {
  test('uses exponential backoff before applying jitter', () => {
    const clock = createClock(1000);
    const policy = new DefaultReconnectPolicy(
      {
        baseMs: 1000,
        maxMs: 30000,
        exponential: true,
        jitter: 'none',
        maxElapsedMs: 600000,
      },
      { clock, random: () => 0.5 },
    );

    policy.startWindow();
    assert.deepStrictEqual(policy.scheduleNextAttempt(), { ok: true, attempt: 1, delayMs: 1000, elapsedMs: 0 });
    assert.deepStrictEqual(policy.scheduleNextAttempt(), { ok: true, attempt: 2, delayMs: 2000, elapsedMs: 0 });
    assert.deepStrictEqual(policy.scheduleNextAttempt(), { ok: true, attempt: 3, delayMs: 4000, elapsedMs: 0 });
  });

  test('uses fixed backoff when exponential is disabled', () => {
    const clock = createClock(2000);
    const policy = new DefaultReconnectPolicy(
      {
        baseMs: 1000,
        maxMs: 30000,
        exponential: false,
        jitter: 'none',
        maxElapsedMs: 600000,
      },
      { clock, random: () => 0.5 },
    );

    policy.startWindow();
    assert.deepStrictEqual(policy.scheduleNextAttempt(), { ok: true, attempt: 1, delayMs: 1000, elapsedMs: 0 });
    assert.deepStrictEqual(policy.scheduleNextAttempt(), { ok: true, attempt: 2, delayMs: 1000, elapsedMs: 0 });
  });

  test('applies full jitter within the capped delay range', () => {
    const clock = createClock(3000);
    const policy = new DefaultReconnectPolicy(
      {
        baseMs: 1000,
        maxMs: 30000,
        exponential: true,
        jitter: 'full',
        maxElapsedMs: 600000,
      },
      { clock, random: () => 0.75 },
    );

    policy.startWindow();
    assert.deepStrictEqual(policy.scheduleNextAttempt(), { ok: true, attempt: 1, delayMs: 750, elapsedMs: 0 });
    assert.deepStrictEqual(policy.scheduleNextAttempt(), { ok: true, attempt: 2, delayMs: 1500, elapsedMs: 0 });
  });

  test('stops scheduling when max elapsed time is exhausted', () => {
    const clock = createClock(4000);
    const policy = new DefaultReconnectPolicy(
      {
        baseMs: 1000,
        maxMs: 30000,
        exponential: true,
        jitter: 'full',
        maxElapsedMs: 5000,
      },
      { clock, random: () => 0.25 },
    );

    policy.startWindow();
    clock.advance(5000);
    assert.deepStrictEqual(policy.scheduleNextAttempt(), { ok: false, elapsedMs: 5000, maxElapsedMs: 5000 });
  });

  test('does not schedule a retry that would overshoot the remaining reconnect budget', () => {
    const clock = createClock(6000);
    const policy = new DefaultReconnectPolicy(
      {
        baseMs: 10,
        maxMs: 10,
        exponential: false,
        jitter: 'none',
        maxElapsedMs: 15,
      },
      { clock, random: () => 0.5 },
    );

    policy.startWindow();
    clock.advance(6);
    assert.deepStrictEqual(policy.scheduleNextAttempt(), { ok: false, elapsedMs: 6, maxElapsedMs: 15 });
  });

  test('resets attempts and reconnect window after success', () => {
    const clock = createClock(5000);
    const policy = new DefaultReconnectPolicy(
      {
        baseMs: 1000,
        maxMs: 30000,
        exponential: true,
        jitter: 'none',
        maxElapsedMs: 600000,
      },
      { clock, random: () => 0.5 },
    );

    policy.startWindow();
    assert.deepStrictEqual(policy.scheduleNextAttempt(), { ok: true, attempt: 1, delayMs: 1000, elapsedMs: 0 });
    clock.advance(1234);
    policy.reset();
    policy.startWindow();
    assert.deepStrictEqual(policy.scheduleNextAttempt(), { ok: true, attempt: 1, delayMs: 1000, elapsedMs: 0 });
  });
});
