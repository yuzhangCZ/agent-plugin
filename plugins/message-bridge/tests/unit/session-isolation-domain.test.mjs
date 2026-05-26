import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultEntryKeyCodec } from '../../src/domain/session-isolation/EntryKeyCodec.ts';

describe('session-isolation domain', () => {
  test('EntryKeyCodec normalizes entry key fields before stringifying', () => {
    const codec = new DefaultEntryKeyCodec();

    const normalized = codec.normalize({
      businessSessionDomain: ' IM ',
      businessSessionType: ' Group ',
      businessSessionId: ' group-001 ',
    });

    assert.deepStrictEqual(normalized, {
      businessSessionDomain: 'im',
      businessSessionType: 'group',
      businessSessionId: 'group-001',
    });
    assert.strictEqual(codec.stringify(normalized), 'im:group:group-001');
  });

  test('EntryKeyCodec preserves businessSessionId case because external ids may be case-sensitive', () => {
    const codec = new DefaultEntryKeyCodec();

    assert.deepStrictEqual(codec.normalize({
      businessSessionDomain: 'MiniApp',
      businessSessionType: 'Direct',
      businessSessionId: ' UserA#BotB ',
    }), {
      businessSessionDomain: 'miniapp',
      businessSessionType: 'direct',
      businessSessionId: 'UserA#BotB',
    });
  });

  test('EntryKeyCodec rejects blank entry key fields', () => {
    const codec = new DefaultEntryKeyCodec();

    assert.throws(
      () => codec.normalize({
        businessSessionDomain: 'im',
        businessSessionType: 'direct',
        businessSessionId: ' ',
      }),
      /businessSessionId_required/u,
    );
  });
});
