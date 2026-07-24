import assert from 'node:assert/strict';
import test from 'node:test';

import { FactSequenceValidator } from '@/application/fact-sequence-validator.ts';

test('FactSequenceValidator enforces order and tool.update fail-closed rules without session lifecycle', () => {
  const validator = new FactSequenceValidator();

  const validToolUpdateState = validator.createState();
  validator.consume(
    'tool-1',
    { type: 'message.start', messageId: 'msg-1' },
    validToolUpdateState,
    { kind: 'request_run' },
  );

  assert.doesNotThrow(
    () => validator.consume(
      'tool-1',
      {
        type: 'tool.update',
        messageId: 'msg-1',
        partId: 'part-1',
        toolCallId: 'call-1',
        toolName: 'shell',
        status: 'running',
        input: { command: 'ls -la' },
        output: 'total 24',
      },
      validToolUpdateState,
      { kind: 'request_run' },
    ),
  );

  for (const input of ['ls -la', [], null, 1, true]) {
    const invalidInputState = validator.createState();
    validator.consume(
      'tool-1',
      { type: 'message.start', messageId: 'msg-invalid-input' },
      invalidInputState,
      { kind: 'request_run' },
    );

    assert.throws(
      () => validator.consume(
        'tool-1',
        {
          type: 'tool.update',
          messageId: 'msg-invalid-input',
          partId: 'part-1',
          toolCallId: 'call-1',
          toolName: 'shell',
          status: 'running',
          input: input as Record<string, unknown>,
        },
        invalidInputState,
        { kind: 'request_run' },
      ),
      /tool\.update input must be a JSON object/,
    );
  }

  const invalidToolUpdateState = validator.createState();
  validator.consume(
    'tool-1',
    { type: 'message.start', messageId: 'msg-invalid-tool' },
    invalidToolUpdateState,
    { kind: 'request_run' },
  );

  assert.throws(
    () => validator.consume(
      'tool-1',
      {
        type: 'tool.update',
        messageId: 'msg-invalid-tool',
        partId: 'part-1',
        toolCallId: 'call-1',
        toolName: 'shell',
        status: 'running',
        output: { nested: true } as unknown as string,
      },
      invalidToolUpdateState,
      { kind: 'request_run' },
    ),
    /tool\.update output must be a string/,
  );

  const outboundState = validator.createState();
  validator.consume(
    'tool-1',
    { type: 'message.start', messageId: 'msg-1' },
    outboundState,
    { kind: 'outbound' },
  );
  validator.consume(
    'tool-1',
    { type: 'message.done', messageId: 'msg-1' },
    outboundState,
    { kind: 'outbound' },
  );

  assert.throws(
    () => validator.consume(
      'tool-1',
      { type: 'session.error', error: { message: 'late' } },
      outboundState,
      { kind: 'outbound' },
    ),
    /facts after terminal are not allowed/,
  );
});

test('FactSequenceValidator accepts new activity after abort because lifecycle is provider-owned', () => {
  const validator = new FactSequenceValidator();
  const state = validator.createState();

  assert.doesNotThrow(() => validator.consume(
    'tool-1',
    { type: 'message.start', messageId: 'msg-after-abort' },
    state,
    { kind: 'request_run' },
  ));
});
