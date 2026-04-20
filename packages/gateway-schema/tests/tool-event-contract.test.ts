import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGatewayWireMessageUpdatedEvent,
  createGatewayWireMessagePartDeltaEvent,
  createGatewayWireMessagePartRemovedEvent,
  createGatewayWireSessionStatusEvent,
  createGatewayWireSessionIdleEvent,
  createGatewayWireSessionUpdatedEvent,
  createGatewayWireSessionErrorEvent,
  createGatewayWirePermissionUpdatedEvent,
  createGatewayWirePermissionAskedEvent,
  createGatewayWireQuestionAskedEvent,
} from '../../test-support/fixtures/index.mjs';
import {
  assertProjectedMessageUpdatedShape,
  assertWireViolationShape,
} from '../../test-support/assertions/index.mjs';
import { validateToolEvent } from '../src/index.ts';

test('validateToolEvent accepts every supported tool_event event type with an exact canonical shape', () => {
  const messageUpdatedInput = structuredClone(createGatewayWireMessageUpdatedEvent());
  messageUpdatedInput.properties.info.agent = 'remove-me';
  messageUpdatedInput.properties.info.time.updated = 456;
  messageUpdatedInput.properties.info.summary.extra = 'drop-me';
  messageUpdatedInput.properties.info.summary.diffs[0].before = { text: 'before' };
  messageUpdatedInput.properties.info.summary.diffs[0].after = { text: 'after' };
  messageUpdatedInput.properties.info.summary.diffs[0].note = 'drop-me';

  const messagePartDeltaInput = structuredClone(createGatewayWireMessagePartDeltaEvent());
  messagePartDeltaInput.properties.extra = 'drop-me';

  const messagePartRemovedInput = structuredClone(createGatewayWireMessagePartRemovedEvent());
  messagePartRemovedInput.properties.extra = 'drop-me';

  const sessionStatusInput = structuredClone(createGatewayWireSessionStatusEvent());
  sessionStatusInput.properties.reason = 'drop-me';
  sessionStatusInput.properties.status.source = 'drop-me';

  const sessionIdleInput = structuredClone(createGatewayWireSessionIdleEvent());
  sessionIdleInput.properties.origin = 'drop-me';

  const sessionUpdatedInput = structuredClone(createGatewayWireSessionUpdatedEvent());
  sessionUpdatedInput.properties.sessionID = 'tool-gateway-wire';
  sessionUpdatedInput.properties.info.title = 'Gateway Title';
  sessionUpdatedInput.properties.info.status = 'drop-me';
  sessionUpdatedInput.properties.note = 'drop-me';

  const sessionErrorInput = structuredClone(createGatewayWireSessionErrorEvent());
  sessionErrorInput.properties.error = 'boom';
  sessionErrorInput.properties.extra = 'drop-me';

  const permissionUpdatedInput = structuredClone(createGatewayWirePermissionUpdatedEvent());
  permissionUpdatedInput.properties.id = 'perm-gateway-wire';
  permissionUpdatedInput.properties.messageID = 'msg-gateway-wire';
  permissionUpdatedInput.properties.type = 'permission';
  permissionUpdatedInput.properties.title = 'Need approval';
  permissionUpdatedInput.properties.metadata = { source: 'test', scope: 'repo' };
  permissionUpdatedInput.properties.response = 'allow';
  permissionUpdatedInput.properties.resolved = true;

  const permissionAskedInput = structuredClone(createGatewayWirePermissionAskedEvent());
  permissionAskedInput.properties.debug = 'drop-me';
  permissionAskedInput.properties.metadata.scope = 'repo';

  const questionAskedInput = structuredClone(createGatewayWireQuestionAskedEvent());
  questionAskedInput.properties.context = 'drop-me';
  questionAskedInput.properties.questions[0].extra = 'drop-me';
  questionAskedInput.properties.questions[0].options[0].internal = 'drop-me';
  questionAskedInput.properties.tool.extra = 'drop-me';

  const cases = [
    {
      name: 'message.part.delta',
      input: messagePartDeltaInput,
      expected: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'tool-gateway-wire',
          messageID: 'msg-gateway-wire',
          partID: 'part-gateway-wire',
          field: 'text',
          delta: 'he',
        },
      },
    },
    {
      name: 'message.part.removed',
      input: messagePartRemovedInput,
      expected: {
        type: 'message.part.removed',
        properties: {
          sessionID: 'tool-gateway-wire',
          messageID: 'msg-gateway-wire',
          partID: 'part-gateway-wire',
        },
      },
    },
    {
      name: 'session.status',
      input: sessionStatusInput,
      expected: {
        type: 'session.status',
        properties: {
          sessionID: 'tool-gateway-wire',
          status: {
            type: 'busy',
          },
        },
      },
    },
    {
      name: 'session.idle',
      input: sessionIdleInput,
      expected: {
        type: 'session.idle',
        properties: {
          sessionID: 'tool-gateway-wire',
        },
      },
    },
    {
      name: 'session.updated',
      input: sessionUpdatedInput,
      expected: {
        type: 'session.updated',
        properties: {
          sessionID: 'tool-gateway-wire',
          info: {
            id: 'tool-gateway-wire',
            title: 'Gateway Title',
          },
        },
      },
    },
    {
      name: 'session.error',
      input: sessionErrorInput,
      expected: {
        type: 'session.error',
        properties: {
          sessionID: 'tool-gateway-wire',
          error: 'boom',
        },
      },
    },
    {
      name: 'permission.updated',
      input: permissionUpdatedInput,
      expected: {
        type: 'permission.updated',
        properties: {
          sessionID: 'tool-gateway-wire',
          id: 'perm-gateway-wire',
          messageID: 'msg-gateway-wire',
          type: 'permission',
          title: 'Need approval',
          metadata: {
            source: 'test',
            scope: 'repo',
          },
          status: 'granted',
          response: 'allow',
          resolved: true,
        },
      },
    },
    {
      name: 'permission.asked',
      input: permissionAskedInput,
      expected: {
        type: 'permission.asked',
        properties: {
          sessionID: 'tool-gateway-wire',
          id: 'perm-gateway-wire',
          messageID: 'msg-gateway-wire',
          type: 'permission',
          title: 'Need approval',
          metadata: {
            source: 'test',
            scope: 'repo',
          },
        },
      },
    },
    {
      name: 'question.asked',
      input: questionAskedInput,
      expected: {
        type: 'question.asked',
        properties: {
          sessionID: 'tool-gateway-wire',
          id: 'question-gateway-wire',
          questions: [
            {
              question: 'Proceed?',
              header: 'Confirm',
              options: [
                {
                  label: 'Yes',
                },
              ],
            },
          ],
          tool: {
            messageID: 'msg-gateway-wire',
            callID: 'call-gateway-wire',
          },
        },
      },
    },
  ];

  for (const { name, input, expected } of cases) {
    const result = validateToolEvent(input);
    assert.equal(result.ok, true, name);
    assert.deepStrictEqual(result.value, { family: 'opencode', ...expected });
  }
});

test('validateToolEvent strips message.updated fields that are not part of the white-list projection', () => {
  const raw = structuredClone(createGatewayWireMessageUpdatedEvent());
  raw.properties.info.summary.diffs[0].before = { text: 'before' };
  raw.properties.info.summary.diffs[0].after = { text: 'after' };
  raw.properties.info.finish = { reason: 'completed' };

  const result = validateToolEvent(raw);

  assert.equal(result.ok, true);
  assertProjectedMessageUpdatedShape(result.value, {
    hasSummary: true,
    additions: 12,
    deletions: 3,
    files: 2,
    diffCount: 1,
    finishReason: 'completed',
  });
  assert.equal('before' in result.value.properties.info.summary.diffs[0], false);
  assert.equal('after' in result.value.properties.info.summary.diffs[0], false);
});

test('validateToolEvent accepts question.asked top-level callID and messageID fallbacks', () => {
  const raw = createGatewayWireQuestionAskedEvent({
    properties: {
      sessionID: 'tool-gateway-wire',
      id: 'question-gateway-wire',
      messageID: 'msg-top-level',
      callID: 'call-top-level',
      questions: [
        {
          question: 'Proceed?',
          header: 'Confirm',
        },
      ],
    },
  });

  const result = validateToolEvent(raw);

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.deepStrictEqual(result.value, {
    family: 'opencode',
    type: 'question.asked',
    properties: {
      sessionID: 'tool-gateway-wire',
      id: 'question-gateway-wire',
      questions: [
        {
          question: 'Proceed?',
          header: 'Confirm',
        },
      ],
      tool: {
        messageID: 'msg-top-level',
        callID: 'call-top-level',
      },
    },
  });
});

test('validateToolEvent accepts question.asked mixed tool and top-level fallbacks', () => {
  const raw = createGatewayWireQuestionAskedEvent({
    properties: {
      sessionID: 'tool-gateway-wire',
      id: 'question-gateway-wire',
      messageID: 'msg-top-level',
      tool: {
        callID: 'call-from-tool',
      },
      questions: [
        {
          question: 'Proceed?',
        },
      ],
    },
  });

  const result = validateToolEvent(raw);

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.deepStrictEqual(result.value, {
    family: 'opencode',
    type: 'question.asked',
    properties: {
      sessionID: 'tool-gateway-wire',
      id: 'question-gateway-wire',
      questions: [
        {
          question: 'Proceed?',
        },
      ],
      tool: {
        messageID: 'msg-top-level',
        callID: 'call-from-tool',
      },
    },
  });
});

test('validateToolEvent rejects malformed events with a shared violation envelope', () => {
  const result = validateToolEvent({
    family: 'opencode',
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-1',
        role: 'assistant',
      },
    },
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'event',
    code: 'missing_required_field',
    field: 'properties.info.sessionID',
    messageType: 'message.updated',
  });
});

test('validateToolEvent rejects unsupported event types', () => {
  const result = validateToolEvent({
    family: 'opencode',
    type: 'session.created',
  });

  assert.equal(result.ok, false);
  assertWireViolationShape(result.error, {
    stage: 'event',
    code: 'unsupported_event_type',
    field: 'type',
    messageType: 'tool_event',
    eventType: 'session.created',
  });
});
