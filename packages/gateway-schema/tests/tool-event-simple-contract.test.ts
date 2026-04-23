import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GATEWAY_WIRE_SIMPLE_TOOL_EVENT_FIXTURES,
  createGatewayWireMessagePartDeltaEvent,
  createGatewayWireMessagePartRemovedEvent,
  createGatewayWirePermissionAskedEvent,
  createGatewayWirePermissionRepliedEvent,
  createGatewayWirePermissionUpdatedEvent,
  createGatewayWireQuestionAskedEvent,
  createGatewayWireSessionErrorEvent,
  createGatewayWireSessionIdleEvent,
  createGatewayWireSessionStatusEvent,
  createGatewayWireSessionUpdatedEvent,
} from '../../test-support/fixtures/index.mjs';
import { assertSimpleToolEventShape, assertWireViolationShape } from '../../test-support/assertions/index.mjs';
import { validateToolEvent } from '../src/index.ts';

test('validateToolEvent keeps the simple tool_event contract aligned with the shared fixtures', () => {
  assert.deepStrictEqual(
    GATEWAY_WIRE_SIMPLE_TOOL_EVENT_FIXTURES.map((fixture) => fixture.type),
    [
      'message.part.delta',
      'message.part.removed',
      'session.status',
      'session.idle',
      'session.updated',
      'session.error',
      'permission.updated',
      'permission.asked',
      'permission.replied',
      'question.asked',
    ],
  );

  const cases = [
    {
      input: (() => {
        const event = structuredClone(createGatewayWireMessagePartDeltaEvent());
        event.properties.extra = 'drop-me';
        return event;
      })(),
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
      input: (() => {
        const event = structuredClone(createGatewayWireMessagePartRemovedEvent());
        event.properties.extra = 'drop-me';
        return event;
      })(),
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
      input: (() => {
        const event = structuredClone(createGatewayWireSessionStatusEvent());
        event.properties.reason = 'drop-me';
        event.properties.status.source = 'drop-me';
        return event;
      })(),
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
      input: (() => {
        const event = structuredClone(createGatewayWireSessionIdleEvent());
        event.properties.origin = 'drop-me';
        return event;
      })(),
      expected: {
        type: 'session.idle',
        properties: {
          sessionID: 'tool-gateway-wire',
        },
      },
    },
    {
      input: (() => {
        const event = structuredClone(createGatewayWireSessionUpdatedEvent());
        event.properties.sessionID = 'tool-gateway-wire';
        event.properties.info.title = 'Gateway Title';
        event.properties.note = 'drop-me';
        return event;
      })(),
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
      input: (() => {
        const event = structuredClone(createGatewayWireSessionErrorEvent());
        event.properties.error = 'boom';
        event.properties.extra = 'drop-me';
        return event;
      })(),
      expected: {
        type: 'session.error',
        properties: {
          sessionID: 'tool-gateway-wire',
          error: 'boom',
        },
      },
    },
    {
      input: (() => {
        const event = structuredClone(createGatewayWirePermissionUpdatedEvent());
        event.properties.id = 'perm-gateway-wire';
        event.properties.messageID = 'msg-gateway-wire';
        event.properties.type = 'permission';
        event.properties.title = 'Need approval';
        event.properties.metadata = {
          source: 'test',
          scope: 'repo',
        };
        event.properties.response = 'allow';
        event.properties.resolved = true;
        return event;
      })(),
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
      input: (() => {
        const event = structuredClone(createGatewayWirePermissionAskedEvent());
        event.properties.debug = 'drop-me';
        event.properties.metadata.scope = 'repo';
        return event;
      })(),
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
      input: (() => {
        const event = structuredClone(createGatewayWirePermissionRepliedEvent());
        event.properties.extra = 'drop-me';
        return event;
      })(),
      expected: {
        type: 'permission.replied',
        properties: {
          sessionID: 'tool-gateway-wire',
          requestID: 'perm-gateway-wire',
          reply: 'always',
        },
      },
    },
    {
      input: (() => {
        const event = structuredClone(createGatewayWireQuestionAskedEvent());
        event.properties.context = 'drop-me';
        event.properties.questions[0].extra = 'drop-me';
        event.properties.questions[0].options[0].internal = 'drop-me';
        event.properties.tool.extra = 'drop-me';
        return event;
      })(),
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

  for (const { input, expected } of cases) {
    const result = validateToolEvent(input);
    assert.equal(result.ok, true);
    if (!result.ok) {
      continue;
    }

    assert.doesNotThrow(() => assertSimpleToolEventShape(result.value, expected));
  }
});

test('validateToolEvent rejects malformed simple events with shared violations', () => {
  const cases = [
    [
      'session.status missing sessionID',
      {
        input: {
          type: 'session.status',
          properties: {
            status: {
              type: 'busy',
            },
          },
        },
        expected: {
          stage: 'event',
          code: 'missing_required_field',
          field: 'properties.sessionID',
          messageType: 'session.status',
          eventType: 'session.status',
        },
      },
    ],
    [
      'session.status invalid status type',
      {
        input: {
          type: 'session.status',
          properties: {
            sessionID: 'tool-gateway-wire',
            status: {
              type: 'paused',
            },
          },
        },
        expected: {
          stage: 'event',
          code: 'invalid_field_value',
          field: 'properties.status.type',
          messageType: 'session.status',
          eventType: 'session.status',
        },
      },
    ],
    [
      'session.idle missing sessionID',
      {
        input: {
          type: 'session.idle',
          properties: {},
        },
        expected: {
          stage: 'event',
          code: 'missing_required_field',
          field: 'properties.sessionID',
          messageType: 'session.idle',
          eventType: 'session.idle',
        },
      },
    ],
    [
      'session.updated missing info.id',
      {
        input: {
          type: 'session.updated',
          properties: {
            info: {},
          },
        },
        expected: {
          stage: 'event',
          code: 'missing_required_field',
          field: 'properties.info.id',
          messageType: 'session.updated',
          eventType: 'session.updated',
        },
      },
    ],
    [
      'session.error invalid error.message type',
      {
        input: {
          type: 'session.error',
          properties: {
            sessionID: 'tool-gateway-wire',
            error: {
              message: 404,
            },
          },
        },
        expected: {
          stage: 'event',
          code: 'invalid_field_type',
          field: 'properties.error',
          messageType: 'session.error',
          eventType: 'session.error',
        },
      },
    ],
    [
      'permission.updated missing sessionID',
      {
        input: {
          type: 'permission.updated',
          properties: {
            status: 'granted',
          },
        },
        expected: {
          stage: 'event',
          code: 'missing_required_field',
          field: 'properties.sessionID',
          messageType: 'permission.updated',
          eventType: 'permission.updated',
        },
      },
    ],
    [
      'permission.updated invalid status type',
      {
        input: {
          type: 'permission.updated',
          properties: {
            sessionID: 'tool-gateway-wire',
            permissionID: 'perm-gateway-wire',
            status: 1,
          },
        },
        expected: {
          stage: 'event',
          code: 'invalid_field_type',
          field: 'properties.status',
          messageType: 'permission.updated',
          eventType: 'permission.updated',
        },
      },
    ],
    [
      'permission.asked missing sessionID',
      {
        input: {
          type: 'permission.asked',
          properties: {
            id: 'perm-gateway-wire',
          },
        },
        expected: {
          stage: 'event',
          code: 'missing_required_field',
          field: 'properties.sessionID',
          messageType: 'permission.asked',
          eventType: 'permission.asked',
        },
      },
    ],
    [
      'question.asked missing question text',
      {
        input: {
          type: 'question.asked',
          properties: {
            sessionID: 'tool-gateway-wire',
            questions: [
              {
                header: 'Confirm',
              },
            ],
          },
        },
        expected: {
          stage: 'event',
          code: 'missing_required_field',
          field: 'properties.questions[].question',
          messageType: 'question.asked',
          eventType: 'question.asked',
        },
      },
    ],
    [
      'message.part.delta invalid field enum',
      {
        input: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'tool-gateway-wire',
            messageID: 'msg-gateway-wire',
            partID: 'part-gateway-wire',
            field: 'tokens',
            delta: 'he',
          },
        },
        expected: {
          stage: 'event',
          code: 'invalid_field_value',
          field: 'properties.field',
          messageType: 'message.part.delta',
          eventType: 'message.part.delta',
        },
      },
    ],
    [
      'message.part.removed missing partID',
      {
        input: {
          type: 'message.part.removed',
          properties: {
            sessionID: 'tool-gateway-wire',
            messageID: 'msg-gateway-wire',
          },
        },
        expected: {
          stage: 'event',
          code: 'missing_required_field',
          field: 'properties.partID',
          messageType: 'message.part.removed',
          eventType: 'message.part.removed',
        },
      },
    ],
  ];

  for (const [name, { input, expected }] of cases) {
    const result = validateToolEvent(input);
    assert.equal(result.ok, false, name);
    if (result.ok) {
      continue;
    }

    assertWireViolationShape(result.error, expected);
  }
});

test('validateToolEvent preserves empty-string payloads for compatible simple opencode events', () => {
  const cases = [
    {
      name: 'message.part.delta keeps empty delta',
      input: createGatewayWireMessagePartDeltaEvent({
        properties: {
          sessionID: 'tool-gateway-wire',
          messageID: 'msg-gateway-wire',
          partID: 'part-gateway-wire',
          field: 'text',
          delta: '',
        },
      }),
      expected: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'tool-gateway-wire',
          messageID: 'msg-gateway-wire',
          partID: 'part-gateway-wire',
          field: 'text',
          delta: '',
        },
      },
    },
    {
      name: 'message.part.delta trims whitespace-only delta to empty string',
      input: createGatewayWireMessagePartDeltaEvent({
        properties: {
          sessionID: 'tool-gateway-wire',
          messageID: 'msg-gateway-wire',
          partID: 'part-gateway-wire',
          field: 'text',
          delta: '\n\t ',
        },
      }),
      expected: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'tool-gateway-wire',
          messageID: 'msg-gateway-wire',
          partID: 'part-gateway-wire',
          field: 'text',
          delta: '',
        },
      },
    },
    {
      name: 'question.asked keeps empty question text and labels',
      input: createGatewayWireQuestionAskedEvent({
        properties: {
          sessionID: 'tool-gateway-wire',
          id: 'question-gateway-wire',
          questions: [
            {
              question: '',
              header: '',
              options: [{ label: '' }],
            },
          ],
          tool: {
            messageID: 'msg-gateway-wire',
            callID: 'call-gateway-wire',
          },
        },
      }),
      expected: {
        type: 'question.asked',
        properties: {
          sessionID: 'tool-gateway-wire',
          id: 'question-gateway-wire',
          questions: [
            {
              question: '',
              header: '',
              options: [{ label: '' }],
            },
          ],
          tool: {
            messageID: 'msg-gateway-wire',
            callID: 'call-gateway-wire',
          },
        },
      },
    },
    {
      name: 'question.asked trims whitespace-only text fields to empty strings',
      input: createGatewayWireQuestionAskedEvent({
        properties: {
          sessionID: 'tool-gateway-wire',
          id: 'question-gateway-wire',
          questions: [
            {
              question: ' \t ',
              header: '\n ',
              options: [{ label: '  ' }],
            },
          ],
          tool: {
            messageID: 'msg-gateway-wire',
            callID: 'call-gateway-wire',
          },
        },
      }),
      expected: {
        type: 'question.asked',
        properties: {
          sessionID: 'tool-gateway-wire',
          id: 'question-gateway-wire',
          questions: [
            {
              question: '',
              header: '',
              options: [{ label: '' }],
            },
          ],
          tool: {
            messageID: 'msg-gateway-wire',
            callID: 'call-gateway-wire',
          },
        },
      },
    },
    {
      name: 'session.error keeps empty string payload',
      input: createGatewayWireSessionErrorEvent({
        properties: {
          sessionID: 'tool-gateway-wire',
          error: '',
        },
      }),
      expected: {
        type: 'session.error',
        properties: {
          sessionID: 'tool-gateway-wire',
          error: '',
        },
      },
    },
    {
      name: 'session.error keeps empty nested message payload',
      input: createGatewayWireSessionErrorEvent({
        properties: {
          sessionID: 'tool-gateway-wire',
          error: {
            message: '',
          },
        },
      }),
      expected: {
        type: 'session.error',
        properties: {
          sessionID: 'tool-gateway-wire',
          error: '',
        },
      },
    },
    {
      name: 'session.error trims whitespace-only nested message payload to empty string',
      input: createGatewayWireSessionErrorEvent({
        properties: {
          sessionID: 'tool-gateway-wire',
          error: {
            message: '\t ',
          },
        },
      }),
      expected: {
        type: 'session.error',
        properties: {
          sessionID: 'tool-gateway-wire',
          error: '',
        },
      },
    },
    {
      name: 'permission.updated keeps empty response and title',
      input: createGatewayWirePermissionUpdatedEvent({
        properties: {
          sessionID: 'tool-gateway-wire',
          id: 'perm-gateway-wire',
          title: '',
          response: '',
        },
      }),
      expected: {
        type: 'permission.updated',
        properties: {
          sessionID: 'tool-gateway-wire',
          id: 'perm-gateway-wire',
          title: '',
          response: '',
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
