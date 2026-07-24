import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolErrorMessageCatalog } from '@/application/projectors/ToolErrorMessageCatalog.ts';

test('catalog maps run_already_active to friendly message ignoring segment', () => {
  const catalog = new ToolErrorMessageCatalog();
  assert.equal(catalog.get('run_already_active'), '当前会话正在处理中，请稍后再试');
  assert.equal(catalog.get('run_already_active', 'ignored'), '当前会话正在处理中，请稍后再试');
});

test('catalog maps pending_interaction_not_found to friendly message', () => {
  const catalog = new ToolErrorMessageCatalog();
  assert.equal(catalog.get('pending_interaction_not_found'), '当前交互已失效，请刷新后重试');
});

test('catalog maps request_run_failed to friendly message', () => {
  const catalog = new ToolErrorMessageCatalog();
  assert.equal(catalog.get('request_run_failed'), '当前请求处理失败，请重试');
});

test('catalog maps unsupported_action with action segment', () => {
  const catalog = new ToolErrorMessageCatalog();
  assert.equal(
    catalog.get('unsupported_action', 'foobar'),
    '暂不支持该操作类型，请检查版本后重试 (unsupported_action: foobar)',
  );
});

test('catalog degrades unsupported_action without segment', () => {
  const catalog = new ToolErrorMessageCatalog();
  assert.equal(
    catalog.get('unsupported_action'),
    '暂不支持该操作类型，请检查版本后重试 (unsupported_action)',
  );
});

test('catalog maps invalid_field_value with field segment', () => {
  const catalog = new ToolErrorMessageCatalog();
  assert.equal(
    catalog.get('invalid_field_value', 'payload.response'),
    '请求格式异常，请稍后重试 (invalid_field_value: payload.response)',
  );
});

test('catalog falls back for unknown wire codes', () => {
  const catalog = new ToolErrorMessageCatalog();
  assert.equal(catalog.get('unsupported_message'), '请求处理异常，请稍后重试');
  assert.equal(catalog.get('unsupported_message', 'new_command'), '请求处理异常，请稍后重试');
  assert.equal(catalog.get('projection_contract_violation'), '请求处理异常，请稍后重试');
});
