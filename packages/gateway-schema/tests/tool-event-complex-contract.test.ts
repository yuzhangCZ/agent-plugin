import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGatewayWireMessageUpdatedEvent,
  createGatewayWireMessagePartUpdatedEvent,
  createGatewayWireMessagePartUpdatedToolEvent,
} from '../../test-support/fixtures/index.mjs';
import {
  assertMessagePartUpdatedShape,
  assertProjectedMessageUpdatedShape,
  assertWireViolationShape,
} from '../../test-support/assertions/index.mjs';
import { validateToolEvent } from '../src/index.ts';

test('validateToolEvent projects message.updated with the canonical white-list shape', () => {
  const raw = structuredClone(createGatewayWireMessageUpdatedEvent());
  raw.properties.info.agent = 'remove-me';
  raw.properties.info.time.updated = 456;
  raw.properties.info.model.thinkLevel = 'deep';
  raw.properties.info.summary.extra = 'drop-me';
  raw.properties.info.summary.diffs[0].before = { text: 'before' };
  raw.properties.info.summary.diffs[0].after = { text: 'after' };
  raw.properties.info.summary.diffs[0].note = 'drop-me';
  raw.properties.info.finish = { reason: 'completed' };

  const result = validateToolEvent(raw);

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assertProjectedMessageUpdatedShape(result.value, {
    id: 'msg-gateway-wire',
    sessionID: 'tool-gateway-wire',
    role: 'assistant',
    created: 1234567890,
    updated: 456,
    model: {
      provider: 'openai',
      name: 'gpt-5',
      thinkLevel: 'deep',
    },
    hasSummary: true,
    additions: 12,
    deletions: 3,
    files: 2,
    diffCount: 1,
    finishReason: 'completed',
  });
  assert.equal('agent' in result.value.properties.info, false);
  assert.equal('extra' in result.value.properties.info.summary, false);
  assert.equal('before' in result.value.properties.info.summary.diffs[0], false);
  assert.equal('after' in result.value.properties.info.summary.diffs[0], false);
  assert.equal('note' in result.value.properties.info.summary.diffs[0], false);
});

test('validateToolEvent rejects malformed message.updated payloads with a shared violation envelope', () => {
  const missingIdResult = validateToolEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-gateway-wire',
        role: 'assistant',
        time: {
          created: 1234567890,
        },
      },
    },
  });

  assert.equal(missingIdResult.ok, false);
  if (missingIdResult.ok) {
    return;
  }
  assertWireViolationShape(missingIdResult.error, {
    stage: 'event',
    code: 'missing_required_field',
    field: 'properties.info.id',
    messageType: 'message.updated',
    eventType: 'message.updated',
  });

  const invalidRoleResult = validateToolEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-gateway-wire',
        sessionID: 'tool-gateway-wire',
        role: 'system',
        time: {
          created: 1234567890,
        },
      },
    },
  });

  assert.equal(invalidRoleResult.ok, false);
  if (invalidRoleResult.ok) {
    return;
  }
  assertWireViolationShape(invalidRoleResult.error, {
    stage: 'event',
    code: 'invalid_field_value',
    field: 'properties.info.role',
    messageType: 'message.updated',
    eventType: 'message.updated',
  });

  const invalidCreatedTypeResult = validateToolEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-gateway-wire',
        sessionID: 'tool-gateway-wire',
        role: 'assistant',
        time: {
          created: 'now',
        },
      },
    },
  });

  assert.equal(invalidCreatedTypeResult.ok, false);
  if (invalidCreatedTypeResult.ok) {
    return;
  }
  assertWireViolationShape(invalidCreatedTypeResult.error, {
    stage: 'event',
    code: 'invalid_field_type',
    field: 'properties.info.time.created',
    messageType: 'message.updated',
    eventType: 'message.updated',
  });
});

test('validateToolEvent accepts message.updated top-level sessionID and messageID fallbacks', () => {
  const raw = {
    type: 'message.updated',
    properties: {
      sessionID: 'tool-top-level',
      messageID: 'msg-top-level',
      info: {
        role: 'assistant',
        time: {
          created: 1234567890,
        },
        finish: {
          reason: 'completed',
        },
      },
    },
  };

  const result = validateToolEvent(raw);

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assertProjectedMessageUpdatedShape(result.value, {
    id: 'msg-top-level',
    sessionID: 'tool-top-level',
    role: 'assistant',
    created: 1234567890,
    finishReason: 'completed',
  });
});

test('validateToolEvent projects message.part.updated text and tool branches with canonical wire shapes', () => {
  const textRaw = structuredClone(createGatewayWireMessagePartUpdatedEvent());
  textRaw.properties.delta = 'first-chunk';
  textRaw.properties.part.extra = 'drop-me';
  textRaw.properties.part.state.reason = 'drop-me';
  const textResult = validateToolEvent(textRaw);

  assert.equal(textResult.ok, true);
  if (!textResult.ok) {
    return;
  }
  assertMessagePartUpdatedShape(textResult.value, {
    delta: 'first-chunk',
    part: {
      id: 'part-gateway-wire',
      sessionID: 'tool-gateway-wire',
      messageID: 'msg-gateway-wire',
      type: 'text',
      text: 'hello',
    },
  });
  assert.equal('tool' in textResult.value.properties.part, false);
  assert.equal('callID' in textResult.value.properties.part, false);
  assert.equal('state' in textResult.value.properties.part, false);

  const toolResult = validateToolEvent(
    (() => {
      const raw = structuredClone(createGatewayWireMessagePartUpdatedToolEvent());
      raw.properties.delta = 'ignored';
      raw.properties.part.extra = 'drop-me';
      raw.properties.part.state.reason = 'drop-me';
      return raw;
    })(),
  );

  assert.equal(toolResult.ok, true);
  if (!toolResult.ok) {
    return;
  }
  assertMessagePartUpdatedShape(toolResult.value, {
    hasDelta: false,
    part: {
      id: 'part-gateway-wire-tool',
      sessionID: 'tool-gateway-wire',
      messageID: 'msg-gateway-wire-tool',
      type: 'tool',
      tool: 'search',
      callID: 'call-gateway-wire-tool',
      state: {
        status: 'completed',
        output: {
          total: 3,
          nested: {
            ok: true,
          },
        },
        error: 'tool failed',
        title: 'Search results',
      },
    },
  });
  assert.equal('delta' in toolResult.value.properties, false);
});

test('validateToolEvent accepts reasoning, step-start, step-finish, and file message parts', () => {
  const cases = [
    {
      name: 'reasoning',
      input: {
        type: 'message.part.updated',
        properties: {
          delta: 'think-chunk',
          part: {
            id: 'part-reasoning',
            sessionID: 'tool-gateway-wire',
            messageID: 'msg-gateway-wire',
            type: 'reasoning',
            text: 'chain-of-thought',
          },
        },
      },
      expected: {
        type: 'message.part.updated',
        properties: {
          delta: 'think-chunk',
          part: {
            id: 'part-reasoning',
            sessionID: 'tool-gateway-wire',
            messageID: 'msg-gateway-wire',
            type: 'reasoning',
            text: 'chain-of-thought',
          },
        },
      },
    },
    {
      name: 'step-start',
      input: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-step-start',
            sessionID: 'tool-gateway-wire',
            messageID: 'msg-gateway-wire',
            type: 'step-start',
          },
        },
      },
      expected: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-step-start',
            sessionID: 'tool-gateway-wire',
            messageID: 'msg-gateway-wire',
            type: 'step-start',
          },
        },
      },
    },
    {
      name: 'step-finish',
      input: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-step-finish',
            sessionID: 'tool-gateway-wire',
            messageID: 'msg-gateway-wire',
            type: 'step-finish',
            tokens: {
              prompt: 12,
              completion: 34,
            },
            cost: 0.42,
            reason: 'completed',
          },
        },
      },
      expected: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-step-finish',
            sessionID: 'tool-gateway-wire',
            messageID: 'msg-gateway-wire',
            type: 'step-finish',
            tokens: {
              prompt: 12,
              completion: 34,
            },
            cost: 0.42,
            reason: 'completed',
          },
        },
      },
    },
    {
      name: 'file',
      input: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-file',
            sessionID: 'tool-gateway-wire',
            messageID: 'msg-gateway-wire',
            type: 'file',
            filename: 'result.txt',
            url: 'https://example.com/result.txt',
            mime: 'text/plain',
          },
        },
      },
      expected: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-file',
            sessionID: 'tool-gateway-wire',
            messageID: 'msg-gateway-wire',
            type: 'file',
            filename: 'result.txt',
            url: 'https://example.com/result.txt',
            mime: 'text/plain',
          },
        },
      },
    },
  ];

  for (const { name, input, expected } of cases) {
    const result = validateToolEvent(input);
    assert.equal(result.ok, true, name);
    if (!result.ok) {
      continue;
    }

    assert.deepStrictEqual(result.value, expected);
  }
});

test('validateToolEvent rejects malformed message.part.updated payloads with a shared violation envelope', () => {
  const missingMessageIdResult = validateToolEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-gateway-wire',
        sessionID: 'tool-gateway-wire',
        type: 'text',
        text: 'hello',
      },
    },
  });

  assert.equal(missingMessageIdResult.ok, false);
  if (missingMessageIdResult.ok) {
    return;
  }
  assertWireViolationShape(missingMessageIdResult.error, {
    stage: 'event',
    code: 'missing_required_field',
    field: 'properties.part.messageID',
    messageType: 'message.part.updated',
    eventType: 'message.part.updated',
  });

  const invalidTypeResult = validateToolEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-gateway-wire',
        sessionID: 'tool-gateway-wire',
        messageID: 'msg-gateway-wire',
        type: 'audio',
        text: 'hello',
      },
    },
  });

  assert.equal(invalidTypeResult.ok, false);
  if (invalidTypeResult.ok) {
    return;
  }
  assertWireViolationShape(invalidTypeResult.error, {
    stage: 'event',
    code: 'invalid_field_value',
    field: 'properties.part.type',
    messageType: 'message.part.updated',
    eventType: 'message.part.updated',
  });

  const invalidStateStatusResult = validateToolEvent({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-gateway-wire-tool',
        sessionID: 'tool-gateway-wire',
        messageID: 'msg-gateway-wire-tool',
        type: 'tool',
        tool: 'search',
        callID: 'call-gateway-wire-tool',
        state: {
          status: 'paused',
        },
      },
    },
  });

  assert.equal(invalidStateStatusResult.ok, false);
  if (invalidStateStatusResult.ok) {
    return;
  }
  assertWireViolationShape(invalidStateStatusResult.error, {
    stage: 'event',
    code: 'invalid_field_value',
    field: 'properties.part.state.status',
    messageType: 'message.part.updated',
    eventType: 'message.part.updated',
  });
});
