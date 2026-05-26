import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultBusinessEntryKeyResolver } from '../../src/runtime/sdk/session-isolation/index.ts';

describe('DefaultBusinessEntryKeyResolver', () => {
  test('resolves normalized BusinessEntryKey from platformExtParam', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        welinkSessionId: 'wl-fallback',
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

  test('does not fall back to welinkSessionId for create_session without explicit business key', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.strictEqual(
      resolver.resolve({
        source: 'create_session',
        welinkSessionId: ' wl-42 ',
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

  test('completes im group chat business key from legacy context fields', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        source: 'chat',
        extParameters: {},
        context: {
          imGroupId: ' group-a ',
          assistantAccount: 'bot-1',
          sendUserAccount: 'user-1',
        },
      }),
      {
        businessSessionDomain: 'im',
        businessSessionType: 'group',
        businessSessionId: 'group-a',
      },
    );
  });

  test('completes im direct chat business key from legacy participant accounts', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        source: 'chat',
        extParameters: {},
        context: {
          assistantAccount: ' bot-1 ',
          sendUserAccount: ' user-1 ',
        },
      }),
      {
        businessSessionDomain: 'im',
        businessSessionType: 'direct',
        businessSessionId: 'user-1#bot-1',
      },
    );
  });

  test('completes miniapp direct chat business key from assistantAccount', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        source: 'chat',
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

  test('returns undefined when neither extParameters nor welinkSessionId can identify the business entry', () => {
    const resolver = new DefaultBusinessEntryKeyResolver();

    assert.strictEqual(
      resolver.resolve({
        welinkSessionId: ' ',
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
