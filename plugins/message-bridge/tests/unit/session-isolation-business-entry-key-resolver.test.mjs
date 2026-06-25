import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultBusinessEntryKeyResolver } from '../../src/runtime/sdk/session-isolation/index.ts';

describe('DefaultBusinessEntryKeyResolver', () => {
  test('resolves normalized BusinessEntryKey from platformExtParam', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        extParameters: {
          platformExtParam: {
            businessSessionDomain: ' IM ',
            businessSessionType: ' Group ',
            businessSessionId: ' group-a ',
          },
        },
      }),
      {
        businessSessionDomain: 'im',
        businessSessionType: 'group',
        businessSessionId: 'group-a',
      },
    );
  });

  test('passes through explicit complete business key for unsupported domain because legality is guarded upstream', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        extParameters: {
          platformExtParam: {
            businessSessionDomain: ' skill ',
            businessSessionType: ' direct ',
            businessSessionId: ' skill-session-1 ',
          },
        },
        context: {
          assistantAccount: 'bot-1',
          sendUserAccount: 'user-1',
        },
      }),
      {
        businessSessionDomain: 'skill',
        businessSessionType: 'direct',
        businessSessionId: 'skill-session-1',
      },
    );
  });

  test('passes through explicit complete business key for miniapp non-direct type because legality is guarded upstream', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        extParameters: {
          platformExtParam: {
            businessSessionDomain: 'miniapp',
            businessSessionType: 'group',
            businessSessionId: 'miniapp-group-1',
          },
        },
        context: {
          assistantAccount: 'miniapp-app-1',
          sendUserAccount: 'miniapp-user-1',
        },
      }),
      {
        businessSessionDomain: 'miniapp',
        businessSessionType: 'group',
        businessSessionId: 'miniapp-group-1',
      },
    );
  });

  test('does not fall back without participant context fields', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.strictEqual(
      resolver.resolve({
        extParameters: {
          platformExtParam: {
            businessSessionDomain: 'im',
            businessSessionType: 'group',
          },
        },
      }),
      undefined,
    );
  });

  test('returns undefined when chat businessSessionDomain is missing even if participant context exists', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.strictEqual(
      resolver.resolve({
        extParameters: {},
        context: {
          assistantAccount: 'bot-1',
          sendUserAccount: 'user-1',
        },
      }),
      undefined,
    );
  });

  test('returns undefined when chat businessSessionDomain is missing even if direct participant accounts exist', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.strictEqual(
      resolver.resolve({
        extParameters: {},
        context: {
          assistantAccount: ' bot-1 ',
          sendUserAccount: ' user-1 ',
        },
      }),
      undefined,
    );
  });

  test('does not complete im group chat business key when businessSessionId is missing', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.strictEqual(
      resolver.resolve({
        extParameters: {
          platformExtParam: {
            businessSessionDomain: ' im ',
            businessSessionType: ' group ',
          },
        },
        context: {
          assistantAccount: 'bot-1',
          sendUserAccount: 'user-1',
        },
      }),
      undefined,
    );
  });

  test('does not complete im direct chat business key when businessSessionId is missing', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.strictEqual(
      resolver.resolve({
        extParameters: {
          platformExtParam: {
            businessSessionDomain: 'im',
            businessSessionType: 'direct',
          },
        },
        context: {
          assistantAccount: ' bot-1 ',
          sendUserAccount: ' user-1 ',
        },
      }),
      undefined,
    );
  });

  test('completes miniapp direct chat business key from assistantAccount', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        context: {
          assistantAccount: ' miniapp-app-1 ',
        },
        extParameters: {
          platformExtParam: {
            businessSessionDomain: 'miniapp',
          },
        },
      }),
      {
        businessSessionDomain: 'miniapp',
        businessSessionType: 'direct',
        businessSessionId: 'miniapp-app-1',
      },
    );
  });

  test('falls back to sendUserAccount for miniapp direct chat when assistantAccount is missing', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        context: {
          sendUserAccount: ' miniapp-user-1 ',
        },
        extParameters: {
          platformExtParam: {
            businessSessionDomain: 'miniapp',
          },
        },
      }),
      {
        businessSessionDomain: 'miniapp',
        businessSessionType: 'direct',
        businessSessionId: 'miniapp-user-1',
      },
    );
  });

  test('returns undefined for miniapp direct chat when both assistantAccount and sendUserAccount are missing', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.strictEqual(
      resolver.resolve({
        extParameters: {
          platformExtParam: {
            businessSessionDomain: 'miniapp',
          },
        },
      }),
      undefined,
    );
  });

  test('does not relax im direct chat fallback when assistantAccount is missing', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.strictEqual(
      resolver.resolve({
        context: {
          sendUserAccount: 'user-1',
        },
        extParameters: {},
      }),
      undefined,
    );
  });

  test('returns undefined for unsupported businessSessionDomain', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.strictEqual(
      resolver.resolve({
        extParameters: {
          platformExtParam: {
            businessSessionDomain: 'skill',
            businessSessionType: 'direct',
          },
        },
        context: {
          assistantAccount: 'bot-1',
          sendUserAccount: 'user-1',
        },
      }),
      undefined,
    );
  });

  test('returns undefined when extParameters cannot identify the business entry', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.strictEqual(
      resolver.resolve({
        extParameters: {
          platformExtParam: {
            businessSessionDomain: 'im',
            businessSessionType: 'group',
            businessSessionId: ' ',
          },
        },
      }),
      undefined,
    );
  });
});
