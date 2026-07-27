import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeContractError } from '@/domain/errors.ts';
import {
  CommandFailureToolErrorProjector,
  ToolErrorMessageCatalog,
} from '@/application/projectors/index.ts';

test('command failure projector maps run_already_active to catalog message', () => {
  const projector = new CommandFailureToolErrorProjector(new ToolErrorMessageCatalog());

  const message = projector.project({
    summary: {
      messageType: 'invoke',
      action: 'chat',
      toolSessionId: 'tool-1',
      welinkSessionId: 'welink-1',
    },
    error: new RuntimeContractError('run_already_active', 'toolSessionId already has an active request run'),
  });

  assert.deepEqual(message, {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: '当前会话正在处理中，请稍后再试',
  });
});

test('command failure projector maps pending_interaction_not_found to catalog message', () => {
  const projector = new CommandFailureToolErrorProjector(new ToolErrorMessageCatalog());

  const message = projector.project({
    summary: {
      messageType: 'invoke',
      action: 'question_reply',
      welinkSessionId: 'welink-1',
    },
    error: new RuntimeContractError('pending_interaction_not_found', 'question interaction not found'),
  });

  assert.deepEqual(message, {
    type: 'tool_error',
    welinkSessionId: 'welink-1',
    error: '当前交互已失效，请刷新后重试',
  });
});

test('command failure projector ignores lifecycle runtime contract failures', () => {
  const projector = new CommandFailureToolErrorProjector(new ToolErrorMessageCatalog());

  const message = projector.project({
    summary: {
      messageType: 'invoke',
      action: 'chat',
      toolSessionId: 'tool-1',
      welinkSessionId: 'welink-1',
    },
    error: new RuntimeContractError('fact_sequence_invalid', 'text.delta requires an open message'),
  });

  assert.equal(message, null);
});

test('command failure projector maps unsupported actions when route fields exist', () => {
  const projector = new CommandFailureToolErrorProjector(new ToolErrorMessageCatalog());

  const message = projector.project({
    summary: {
      messageType: 'invoke',
      action: 'unsupported_action',
      toolSessionId: 'tool-1',
      welinkSessionId: 'welink-1',
    },
    error: new Error('Unsupported downstream action: unsupported_action'),
  });

  assert.deepEqual(message, {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    welinkSessionId: 'welink-1',
    error: '暂不支持该操作类型，请检查版本后重试 (unsupported_action)',
  });
});

test('command failure projector maps unsupported downstream errors to catalog message', () => {
  const projector = new CommandFailureToolErrorProjector(new ToolErrorMessageCatalog());

  const message = projector.project({
    summary: {
      messageType: 'invoke',
      action: 'chat',
      toolSessionId: 'tool-1',
    },
    error: new Error('Unsupported downstream action: chat'),
  });

  assert.deepEqual(message, {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: '暂不支持该操作类型，请检查版本后重试 (unsupported_action)',
  });
});

test('command failure projector reports non-catalog errors for unsupported routed actions', () => {
  const projector = new CommandFailureToolErrorProjector(new ToolErrorMessageCatalog());

  const message = projector.project({
    summary: {
      messageType: 'invoke',
      action: 'future_action',
      toolSessionId: 'tool-1',
      welinkSessionId: 'welink-1',
    },
    error: new Error('future action failed'),
  });

  assert.deepEqual(message, {
    type: 'tool_error',
    toolSessionId: 'tool-1',
    error: 'future action failed',
  });
});

test('command failure projector keeps welinkSessionId when it is the only route field', () => {
  const projector = new CommandFailureToolErrorProjector(new ToolErrorMessageCatalog());

  const message = projector.project({
    summary: {
      messageType: 'invoke',
      action: 'future_action',
      welinkSessionId: 'welink-1',
    },
    error: new Error('future action failed'),
  });

  assert.deepEqual(message, {
    type: 'tool_error',
    welinkSessionId: 'welink-1',
    error: 'future action failed',
  });
});

test('command failure projector keeps welinkSessionId for create_session failures without toolSessionId', () => {
  const projector = new CommandFailureToolErrorProjector(new ToolErrorMessageCatalog());

  const message = projector.project({
    summary: {
      messageType: 'invoke',
      action: 'create_session',
      welinkSessionId: 'welink-create-1',
    },
    error: new Error('create_session_failed'),
  });

  assert.deepEqual(message, {
    type: 'tool_error',
    welinkSessionId: 'welink-create-1',
    error: 'create_session_failed',
  });
});
