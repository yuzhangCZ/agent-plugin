import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DefaultBusinessEntryPolicyResolver,
} from '../../src/runtime/sdk/session-isolation/index.ts';

describe('DefaultBusinessEntryPolicyResolver', () => {
  test('uses im group template by entry key', () => {
    const resolver = new DefaultBusinessEntryPolicyResolver();

    assert.deepStrictEqual(resolver.resolve({
      entryKey: {
        businessSessionDomain: 'im',
        businessSessionType: 'group',
        businessSessionId: 'group-a',
      },
      extParameters: {},
    }), {
      entryKey: 'im:group:group-a',
      controlled: true,
      allowOpencodeNativeSessions: false,
      allowedSlashCommands: ['new', 'models', 'model'],
      slashPolicySource: 'entry_template',
    });
  });

  test('uses im direct template by entry key', () => {
    const resolver = new DefaultBusinessEntryPolicyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        entryKey: {
          businessSessionDomain: 'im',
          businessSessionType: 'direct',
          businessSessionId: 'user-a#bot-a',
        },
        extParameters: {},
      }),
      {
        entryKey: 'im:direct:user-a#bot-a',
        controlled: false,
        allowOpencodeNativeSessions: true,
        allowedSlashCommands: ['new', 'sessions', 'session', 'models', 'model'],
        slashPolicySource: 'entry_template',
      },
    );
  });

  test('intersects request scoped allowedSlashCommands with template', () => {
    const resolver = new DefaultBusinessEntryPolicyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        entryKey: {
          businessSessionDomain: 'im',
          businessSessionType: 'group',
          businessSessionId: 'group-a',
        },
        extParameters: {
          platformExtParam: {
            allowedSlashCommands: ['sessions', 'new', 'model'],
          },
        },
      }),
      {
        entryKey: 'im:group:group-a',
        controlled: true,
        allowOpencodeNativeSessions: false,
        allowedSlashCommands: ['new', 'model'],
        slashPolicySource: 'request_payload',
      },
    );
  });

  test('treats empty allowedSlashCommands as explicit slash disable', () => {
    const resolver = new DefaultBusinessEntryPolicyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        entryKey: {
          businessSessionDomain: 'miniapp',
          businessSessionType: 'direct',
          businessSessionId: 'assistant-a',
        },
        extParameters: {
          platformExtParam: {
            allowedSlashCommands: [],
          },
        },
      }),
      {
        entryKey: 'miniapp:direct:assistant-a',
        controlled: false,
        allowOpencodeNativeSessions: true,
        allowedSlashCommands: [],
        slashPolicySource: 'request_payload',
      },
    );
  });

  test('filters invalid allowedSlashCommands before applying request policy', () => {
    const resolver = new DefaultBusinessEntryPolicyResolver();

    assert.deepStrictEqual(
      resolver.resolve({
        entryKey: {
          businessSessionDomain: 'im',
          businessSessionType: 'direct',
          businessSessionId: 'user-a#bot-a',
        },
        extParameters: {
          platformExtParam: {
            allowedSlashCommands: ['sessions', 'unknown', '', 'new'],
          },
        },
      }),
      {
        entryKey: 'im:direct:user-a#bot-a',
        controlled: false,
        allowOpencodeNativeSessions: true,
        allowedSlashCommands: ['sessions', 'new'],
        slashPolicySource: 'request_payload',
      },
    );
  });
});
