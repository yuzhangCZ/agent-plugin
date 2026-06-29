import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAbortSessionInvokeMessage,
  createChatInvokeMessage,
  createCloseSessionInvokeMessage,
  createGatewayWireCreateSessionInvokeMessage,
  createGatewayWireLegacyCreateSessionInvokeMessage,
  createPermissionReplyInvokeMessage,
  createQuestionReplyInvokeMessage,
  createQuerySlashCommandsInvokeMessage,
  createStatusQueryMessage,
} from '../../test-support/fixtures/index.mjs';
import { assertWireViolationShape } from '../../test-support/assertions/index.mjs';
import { normalizeDownstream } from '../src/index.ts';

test('normalizeDownstream accepts the full downstream contract', () => {
  const cases = [
    [
      'status_query',
      createStatusQueryMessage(),
      {
        type: 'status_query',
      },
    ],
    [
      'chat',
      createChatInvokeMessage({
        welinkSessionId: 'wl-chat',
        suppressReply: true,
        payload: {
          toolSessionId: 'tool-chat',
          text: 'hello',
          assistantId: 'persona-a',
          assistantAccount: 'assistant-account-a',
          sendUserAccount: 'sender-account-a',
          imGroupId: 'group-a',
        },
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-chat',
        action: 'chat',
        suppressReply: true,
        payload: {
          toolSessionId: 'tool-chat',
          text: 'hello',
          assistantId: 'persona-a',
          assistantAccount: 'assistant-account-a',
          sendUserAccount: 'sender-account-a',
          imGroupId: 'group-a',
        },
      },
    ],
    [
      'create_session',
      createGatewayWireCreateSessionInvokeMessage({
        welinkSessionId: 'wl-create',
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-create',
        action: 'create_session',
        payload: {
          title: 'gateway-wire session',
          assistantId: 'persona-gateway',
        },
      },
    ],
    [
      'close_session',
      createCloseSessionInvokeMessage({
        welinkSessionId: 'wl-close',
        payload: { toolSessionId: 'tool-close' },
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-close',
        action: 'close_session',
        payload: {
          toolSessionId: 'tool-close',
        },
      },
    ],
    [
      'abort_session',
      createAbortSessionInvokeMessage({
        welinkSessionId: 'wl-abort',
        payload: { toolSessionId: 'tool-abort' },
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-abort',
        action: 'abort_session',
        payload: {
          toolSessionId: 'tool-abort',
        },
      },
    ],
    [
      'query_slash_commands',
      createQuerySlashCommandsInvokeMessage({
        toolSessionId: 'tool-query-slash',
        traceId: 'trace-query-slash',
        payload: {
          extParameters: {
            platformExtParam: {
              businessSessionDomain: 'im',
              businessSessionType: 'direct',
              businessSessionId: 'user-a#bot-a',
            },
          },
        },
      }),
      {
        type: 'invoke',
        toolSessionId: 'tool-query-slash',
        traceId: 'trace-query-slash',
        action: 'query_slash_commands',
        payload: {
          extParameters: {
            platformExtParam: {
              businessSessionDomain: 'im',
              businessSessionType: 'direct',
              businessSessionId: 'user-a#bot-a',
            },
          },
        },
      },
    ],
    [
      'permission_reply',
      createPermissionReplyInvokeMessage({
        welinkSessionId: 'wl-permission',
        payload: {
          permissionId: 'perm-1',
          response: 'once',
        },
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-permission',
        action: 'permission_reply',
        payload: {
          permissionId: 'perm-1',
          response: 'once',
        },
      },
    ],
    [
      'question_reply',
      createQuestionReplyInvokeMessage({
        welinkSessionId: 'wl-question',
        payload: {
          questionId: 'question-1',
          answer: 'ok',
        },
      }),
      {
        type: 'invoke',
        welinkSessionId: 'wl-question',
        action: 'question_reply',
        payload: {
          questionId: 'question-1',
          answers: [['ok']],
        },
      },
    ],
  ];

  for (const [name, input, expected] of cases) {
    if (name === 'query_slash_commands') {
      assert.equal('welinkSessionId' in input, false);
    }
    const result = normalizeDownstream(input);
    assert.equal(result.ok, true, name);
    assert.deepEqual(result.value, expected);
  }
});

test('normalizeDownstream ignores deprecated assiantId instead of treating it as assistantId', () => {
  const cases = [
    createChatInvokeMessage({
      welinkSessionId: 'wl-chat-legacy',
      payload: {
        toolSessionId: 'tool-chat-legacy',
        text: 'hello',
        assiantId: 'persona-legacy',
      },
    }),
    createGatewayWireCreateSessionInvokeMessage({
      welinkSessionId: 'wl-create-legacy',
      payload: {
        title: 'legacy assistant field',
        assiantId: 'persona-legacy',
      },
    }),
  ];

  for (const input of cases) {
    const result = normalizeDownstream(input);
    assert.equal(result.ok, true);
    if (!result.ok || result.value.type !== 'invoke') {
      continue;
    }

    assert.equal('assistantId' in result.value.payload, false);
    assert.equal('assiantId' in result.value.payload, false);
  }
});

test('normalizeDownstream ignores legacy create_session payload fields in the shared contract', () => {
  const result = normalizeDownstream(createGatewayWireLegacyCreateSessionInvokeMessage());

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    welinkSessionId: 'wl-gateway-legacy-create',
    action: 'create_session',
    payload: {},
  });
  assert.equal('sessionId' in result.value.payload, false);
  assert.equal('metadata' in result.value.payload, false);
});

test('normalizeDownstream rejects missing create_session welinkSessionId', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'create_session',
    payload: {
      title: 'missing welink',
    },
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'missing_required_field',
    field: 'welinkSessionId',
    messageType: 'invoke',
    action: 'create_session',
  });
});

test('normalizeDownstream rejects invalid permission_reply response values', () => {
  const result = normalizeDownstream(
    createPermissionReplyInvokeMessage({
      payload: {
        toolSessionId: 'tool-permission',
        permissionId: 'perm-1',
        response: 'invalid',
      },
    }),
  );

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_value',
    field: 'payload.response',
    messageType: 'invoke',
    action: 'permission_reply',
  });
});

test('normalizeDownstream rejects non-string chat assistantId', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      welinkSessionId: 'wl-chat-invalid-assistant',
      payload: {
        toolSessionId: 'tool-chat-invalid-assistant',
        text: 'hello',
        assistantId: 123,
      },
    }),
  );

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_type',
    field: 'payload.assistantId',
    messageType: 'invoke',
    action: 'chat',
  });
});

test('normalizeDownstream trims optional chat compat fields and preserves top-level boolean suppressReply', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      suppressReply: true,
      payload: {
        toolSessionId: 'tool-chat-trim',
        text: 'hello',
        assistantAccount: ' assistant-account-trim ',
        sendUserAccount: ' sender-account-trim ',
        imGroupId: ' group-trim ',
      },
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.deepStrictEqual(result.value, {
    type: 'invoke',
    welinkSessionId: 'wl-chat',
    action: 'chat',
    suppressReply: true,
    payload: {
      toolSessionId: 'tool-chat-trim',
      text: 'hello',
      assistantAccount: 'assistant-account-trim',
      sendUserAccount: 'sender-account-trim',
      imGroupId: 'group-trim',
    },
  });
});

test('normalizeDownstream accepts null chat compat fields and omits them after normalization', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      payload: {
        toolSessionId: 'tool-chat-null-compat',
        text: 'hello',
        assistantAccount: null,
        sendUserAccount: null,
        imGroupId: null,
      },
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.deepStrictEqual(result.value, {
    type: 'invoke',
    welinkSessionId: 'wl-chat',
    action: 'chat',
    payload: {
      toolSessionId: 'tool-chat-null-compat',
      text: 'hello',
    },
  });
});

test('normalizeDownstream preserves chat payload extParameters object', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      payload: {
        toolSessionId: 'tool-chat-ext-parameters',
        text: 'hello',
        extParameters: {
          extEnvelopeVersion: 2,
          businessExtParam: {
            scene: 'workflow',
            nested: {
              enabled: true,
              level: 2,
            },
          },
          platformExtParam: {
            businessSessionDomain: 'im',
            businessSessionType: 'group',
            businessSessionId: 'session-1',
            allowedSlashCommands: ['plan', 'ask'],
            futureField: {
              rollout: true,
            },
          },
        },
      },
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.deepStrictEqual(result.value, {
    type: 'invoke',
    welinkSessionId: 'wl-chat',
    action: 'chat',
    payload: {
      toolSessionId: 'tool-chat-ext-parameters',
      text: 'hello',
      extParameters: {
        extEnvelopeVersion: 2,
        businessExtParam: {
          scene: 'workflow',
          nested: {
            enabled: true,
            level: 2,
          },
        },
        platformExtParam: {
          businessSessionDomain: 'im',
          businessSessionType: 'group',
          businessSessionId: 'session-1',
          allowedSlashCommands: ['plan', 'ask'],
          futureField: {
            rollout: true,
          },
        },
      },
    },
  });
});

test('normalizeDownstream preserves empty chat payload extParameters object', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      payload: {
        toolSessionId: 'tool-chat-empty-ext-parameters',
        text: 'hello',
        extParameters: {},
      },
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.deepStrictEqual(result.value, {
    type: 'invoke',
    welinkSessionId: 'wl-chat',
    action: 'chat',
    payload: {
      toolSessionId: 'tool-chat-empty-ext-parameters',
      text: 'hello',
      extParameters: {},
    },
  });
});

test('normalizeDownstream drops blank optional chat compat fields', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      payload: {
        toolSessionId: 'tool-chat-blank',
        text: 'hello',
        assistantAccount: '   ',
        sendUserAccount: '',
        imGroupId: '\n\t',
      },
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.deepStrictEqual(result.value, {
    type: 'invoke',
    welinkSessionId: 'wl-chat',
    action: 'chat',
    payload: {
      toolSessionId: 'tool-chat-blank',
      text: 'hello',
    },
  });
});

test('normalizeDownstream omits absent chat payload extParameters', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      payload: {
        toolSessionId: 'tool-chat-no-ext-parameters',
        text: 'hello',
      },
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal('extParameters' in result.value.payload, false);
});

test('normalizeDownstream rejects non-boolean chat suppressReply', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      suppressReply: 'false',
      payload: {
        toolSessionId: 'tool-chat-invalid-suppress-reply',
        text: 'hello',
      },
    }),
  );

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_type',
    field: 'suppressReply',
    messageType: 'invoke',
    action: 'chat',
  });
});

test('normalizeDownstream rejects array chat extParameters', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      payload: {
        toolSessionId: 'tool-chat-array-ext-parameters',
        text: 'hello',
        extParameters: ['invalid-array'],
      },
    }),
  );

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_type',
    field: 'payload.extParameters',
    messageType: 'invoke',
    action: 'chat',
  });
});

test('normalizeDownstream rejects null chat extParameters', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      payload: {
        toolSessionId: 'tool-chat-null-ext-parameters',
        text: 'hello',
        extParameters: null,
      },
    }),
  );

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_type',
    field: 'payload.extParameters',
    messageType: 'invoke',
    action: 'chat',
  });
});

test('normalizeDownstream rejects primitive chat extParameters', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      payload: {
        toolSessionId: 'tool-chat-primitive-ext-parameters',
        text: 'hello',
        extParameters: 'invalid-primitive',
      },
    }),
  );

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_type',
    field: 'payload.extParameters',
    messageType: 'invoke',
    action: 'chat',
  });
});

test('normalizeDownstream rejects non-json-object chat extParameters like Date', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      payload: {
        toolSessionId: 'tool-chat-date-ext-parameters',
        text: 'hello',
        extParameters: new Date('2026-05-19T00:00:00.000Z'),
      },
    }),
  );

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_type',
    field: 'payload.extParameters',
    messageType: 'invoke',
    action: 'chat',
  });
});

test('normalizeDownstream preserves platformExtParam business fields without semantic normalization', () => {
  const normalized = normalizeDownstream(
    createChatInvokeMessage({
      payload: {
        toolSessionId: 'tool-chat-null-platform-fields',
        text: 'hello',
        extParameters: {
          platformExtParam: {
            businessSessionDomain: null,
            businessSessionType: '  ',
            businessSessionId: 123,
            allowedSlashCommands: ['plan', 1],
          },
        },
      },
    }),
  );

  assert.equal(normalized.ok, true);
  if (!normalized.ok) {
    return;
  }

  assert.deepStrictEqual(normalized.value.payload.extParameters, {
    platformExtParam: {
      businessSessionDomain: null,
      businessSessionType: '  ',
      businessSessionId: 123,
      allowedSlashCommands: ['plan', 1],
    },
  });
});

test('normalizeDownstream preserves arbitrary businessExtParam values', () => {
  const cases = [
    null,
    ['array'],
    'plain-string',
    '{invalid-json',
    '["array"]',
    '"primitive"',
    new Date('2026-05-19T00:00:00.000Z'),
    {
      date: new Date('2026-05-19T00:00:00.000Z'),
      compute: () => true,
    },
  ];

  for (const businessExtParam of cases) {
    const result = normalizeDownstream(
      createChatInvokeMessage({
        payload: {
          toolSessionId: 'tool-chat-invalid-business-ext-param',
          text: 'hello',
          extParameters: {
            businessExtParam,
          },
        },
      }),
    );

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.payload.extParameters?.businessExtParam, businessExtParam);
  }
});

test('normalizeDownstream rejects non JSON object platformExtParam', () => {
  const result = normalizeDownstream(
    createChatInvokeMessage({
      payload: {
        toolSessionId: 'tool-chat-invalid-platform-ext-param',
        text: 'hello',
        extParameters: {
          platformExtParam: {
            compute: () => true,
          },
        },
      },
    }),
  );

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_type',
    field: 'payload.extParameters.platformExtParam',
    messageType: 'invoke',
    action: 'chat',
  });
});

test('normalizeDownstream rejects non object platformExtParam values', () => {
  const cases = [
    ['platformExtParam', null],
    ['platformExtParam', ['array']],
    ['platformExtParam', 'primitive'],
    ['platformExtParam', new Date('2026-05-19T00:00:00.000Z')],
  ];

  for (const [key, value] of cases) {
    const result = normalizeDownstream(
      createChatInvokeMessage({
        payload: {
          toolSessionId: `tool-chat-invalid-${key}`,
          text: 'hello',
          extParameters: {
            [key]: value,
          },
        },
      }),
    );

    assert.equal(result.ok, false, key);
    assertWireViolationShape(result.error, {
      stage: 'payload',
      code: 'invalid_field_type',
      field: `payload.extParameters.${key}`,
      messageType: 'invoke',
      action: 'chat',
    });
  }
});

test('normalizeDownstream preserves query_slash_commands empty extParameters object', () => {
  const result = normalizeDownstream(
    createQuerySlashCommandsInvokeMessage({
      toolSessionId: 'tool-query-empty-ext',
      traceId: 'trace-query-empty-ext',
      payload: {
        extParameters: {},
      },
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.deepStrictEqual(result.value, {
    type: 'invoke',
    action: 'query_slash_commands',
    toolSessionId: 'tool-query-empty-ext',
    traceId: 'trace-query-empty-ext',
    payload: {
      extParameters: {},
    },
  });
});

test('normalizeDownstream rejects query_slash_commands without toolSessionId', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'query_slash_commands',
    welinkSessionId: 'wl-query-legacy',
    traceId: 'trace-query-legacy',
    payload: {},
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'missing_required_field',
    field: 'toolSessionId',
    messageType: 'invoke',
    action: 'query_slash_commands',
  });
});

test('normalizeDownstream preserves query_slash_commands extParameters extension objects', () => {
  const result = normalizeDownstream(
    createQuerySlashCommandsInvokeMessage({
      toolSessionId: 'tool-query-ext',
      traceId: 'trace-query-ext',
      payload: {
        extParameters: {
          businessExtParam: {
            nested: {
              enabled: true,
            },
          },
          platformExtParam: {
            businessSessionDomain: null,
            allowedSlashCommands: ['new', 1],
          },
          futureField: new Date('2026-05-19T00:00:00.000Z'),
        },
      },
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.deepStrictEqual(result.value.payload, {
    extParameters: {
      businessExtParam: {
        nested: {
          enabled: true,
        },
      },
      platformExtParam: {
        businessSessionDomain: null,
        allowedSlashCommands: ['new', 1],
      },
      futureField: new Date('2026-05-19T00:00:00.000Z'),
    },
  });
});

test('normalizeDownstream accepts question_reply without welinkSessionId through the public API', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-1',
      answer: 'ok',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-1',
      answers: [['ok']],
    },
  });
});

test('normalizeDownstream accepts structured question_reply answers', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-structured-1',
      answers: [['A'], ['B', 'C']],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-structured-1',
      answers: [['A'], ['B', 'C']],
    },
  });
});

test('normalizeDownstream accepts serialized structured question_reply answer', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-serialized-answer-1',
      answer: '[["A"],["B","C"]]',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-serialized-answer-1',
      answers: [['A'], ['B', 'C']],
    },
  });
});

test('normalizeDownstream prefers structured question_reply answers over legacy answer', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-structured-2',
      answers: [['A'], ['B', 'C']],
      answer: 'legacy ignored',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-structured-2',
      answers: [['A'], ['B', 'C']],
    },
  });
});

test('normalizeDownstream treats non-json question_reply answer as legacy string', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-non-json-answer-1',
      answer: '[not json',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-non-json-answer-1',
      answers: [['[not json']],
    },
  });
});

test('normalizeDownstream accepts empty legacy question_reply answer string', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-empty-legacy-answer-1',
      answer: '',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-empty-legacy-answer-1',
      answers: [['']],
    },
  });
});

test('normalizeDownstream treats non-array json question_reply answer as legacy string', () => {
  const cases = [
    { questionId: 'question-json-string-answer-1', answer: '"ok"' },
    { questionId: 'question-json-number-answer-1', answer: '123' },
    { questionId: 'question-json-object-answer-1', answer: '{}' },
  ];

  for (const input of cases) {
    const result = normalizeDownstream({
      type: 'invoke',
      action: 'question_reply',
      payload: input,
    });

    assert.equal(result.ok, true, input.questionId);
    assert.deepEqual(result.value, {
      type: 'invoke',
      action: 'question_reply',
      payload: {
        questionId: input.questionId,
        answers: [[input.answer]],
      },
    });
  }
});

test('normalizeDownstream accepts question_reply using legacy toolCallId alias', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      toolCallId: 'question-legacy-1',
      answer: 'ok',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-legacy-1',
      answers: [['ok']],
    },
  });
});

test('normalizeDownstream prefers questionId over toolCallId for question_reply', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-primary-1',
      toolCallId: 'question-legacy-shadow-1',
      answer: 'ok',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-primary-1',
      answers: [['ok']],
    },
  });
});

test('normalizeDownstream accepts empty serialized question_reply answer arrays', () => {
  const cases = [
    { questionId: 'question-empty-serialized-answer-1', answer: '[]', answers: [] },
    { questionId: 'question-empty-serialized-group-1', answer: '[[]]', answers: [[]] },
    { questionId: 'question-empty-serialized-item-1', answer: '[[""]]', answers: [['']] },
  ];

  for (const input of cases) {
    const result = normalizeDownstream({
      type: 'invoke',
      action: 'question_reply',
      payload: {
        questionId: input.questionId,
        answer: input.answer,
      },
    });

    assert.equal(result.ok, true, input.questionId);
    assert.deepEqual(result.value, {
      type: 'invoke',
      action: 'question_reply',
      payload: {
        questionId: input.questionId,
        answers: input.answers,
      },
    });
  }
});

test('normalizeDownstream rejects serialized question_reply answer arrays with non-array groups', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-flat-serialized-answer-1',
      answer: '["A"]',
    },
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_type',
    field: 'payload.answer',
    messageType: 'invoke',
    action: 'question_reply',
  });
});

test('normalizeDownstream rejects question_reply without answer or answers', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-missing-answer-1',
    },
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_type',
    field: 'payload.answers',
    messageType: 'invoke',
    action: 'question_reply',
  });
});

test('normalizeDownstream accepts question_reply empty structured answers', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-empty-answers-1',
      answers: [],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-empty-answers-1',
      answers: [],
    },
  });
});

test('normalizeDownstream accepts question_reply empty answer group', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-empty-answer-group-1',
      answers: [[]],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-empty-answer-group-1',
      answers: [[]],
    },
  });
});

test('normalizeDownstream accepts question_reply empty answer item', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-empty-answer-item-1',
      answers: [['A'], ['']],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    type: 'invoke',
    action: 'question_reply',
    payload: {
      questionId: 'question-empty-answer-item-1',
      answers: [['A'], ['']],
    },
  });
});

test('normalizeDownstream rejects question_reply when both questionId and toolCallId are missing', () => {
  const result = normalizeDownstream({
    type: 'invoke',
    action: 'question_reply',
    payload: {
      answer: 'ok',
    },
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'payload',
    code: 'invalid_field_type',
    field: 'payload.questionId',
    messageType: 'invoke',
    action: 'question_reply',
  });
});
