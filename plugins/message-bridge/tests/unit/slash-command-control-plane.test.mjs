import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SimpleBridgeLocalSlashCommandParser,
} from '../../src/adapter/index.ts';
import {
  DefaultSlashCommandReplyPresenter,
} from '../../src/usecase/index.ts';

describe('slash command control plane', () => {
  test('bridge-local parser matches known standalone commands', () => {
    const parser = new SimpleBridgeLocalSlashCommandParser();

    assert.deepStrictEqual(parser.tryParse({
      text: '/new',
    }), {
      kind: 'matched',
      command: { kind: 'new' },
    });
    assert.deepStrictEqual(parser.tryParse({
      text: '/sessions',
    }), {
      kind: 'matched',
      command: { kind: 'sessions' },
    });
    assert.deepStrictEqual(parser.tryParse({
      text: '/models',
    }), {
      kind: 'matched',
      command: { kind: 'models' },
    });
  });

  test('bridge-local parser matches parameterized commands', () => {
    const parser = new SimpleBridgeLocalSlashCommandParser();

    assert.deepStrictEqual(parser.tryParse({
      text: '/session ses-2',
    }), {
      kind: 'matched',
      command: { kind: 'session', sessionId: 'ses-2' },
    });
    assert.deepStrictEqual(parser.tryParse({
      text: '/model openai/gpt-5',
    }), {
      kind: 'matched',
      command: { kind: 'model', providerId: 'openai', modelId: 'gpt-5' },
    });
  });

  test('bridge-local parser reports invalid known command arguments', () => {
    const parser = new SimpleBridgeLocalSlashCommandParser();

    assert.deepStrictEqual(parser.tryParse({
      text: '/model openai',
    }), {
      kind: 'invalid',
      command: { kind: 'model' },
    });
    assert.deepStrictEqual(parser.tryParse({
      text: '/session',
    }), {
      kind: 'invalid',
      command: { kind: 'session' },
    });
  });

  test('bridge-local parser ignores unknown slash and plain text', () => {
    const parser = new SimpleBridgeLocalSlashCommandParser();

    assert.deepStrictEqual(parser.tryParse({
      text: '/init project',
    }), { kind: 'none' });
    assert.deepStrictEqual(parser.tryParse({
      text: 'hello',
    }), { kind: 'none' });
  });

  test('presenter renders stable success and failure text', () => {
    const presenter = new DefaultSlashCommandReplyPresenter();

    assert.strictEqual(
      presenter.presentSuccess({
        kind: 'sessions',
        activeSessionId: 'ses-1',
        sessions: [
          { id: 'ses-1', title: '会话一' },
          { id: 'ses-2', title: '会话二' },
        ],
      }),
      '可切换会话列表\n\n- `ses-1` 会话一（当前）\n- `ses-2` 会话二',
    );
    assert.strictEqual(
      presenter.presentFailure(
        { kind: 'session' },
        { code: 'session_out_of_scope' },
      ),
      '切换会话失败, 目标会话不在当前可切换范围内',
    );
    assert.strictEqual(
      presenter.presentFailure(
        { kind: 'sessions' },
        { code: 'command_disabled_in_group_chat' },
      ),
      '查询会话列表失败, 群聊场景不支持 /sessions，请在单聊中使用',
    );
  });

});
