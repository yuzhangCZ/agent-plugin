import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryGatewayEnvelopeProjector } from '../../src/runtime/GatewayEnvelopeProjector.ts';
import { SyntheticAssistantReplySequenceBuilder } from '../../src/runtime/SyntheticAssistantReplySequenceBuilder.ts';
import { SyntheticAssistantReplySender } from '../../src/runtime/SyntheticAssistantReplySender.ts';

function createLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => createLogger(),
    getTraceId: () => 'runtime-trace-test',
  };
}

function normalizeSyntheticReplyEvents(events) {
  return events.map((event) => {
    if (event.type === 'tool_done') {
      return event;
    }

    if (event.event?.type === 'message.updated') {
      return {
        ...event,
        event: {
          ...event.event,
          properties: {
            ...event.event.properties,
            info: {
              ...event.event.properties.info,
              id: '<message-id>',
              time: {
                ...event.event.properties.info.time,
                created: '<created-at>',
              },
            },
          },
        },
      };
    }

    if (event.event?.type === 'message.part.updated') {
      return {
        ...event,
        event: {
          ...event.event,
          properties: {
            ...event.event.properties,
            part: {
              ...event.event.properties.part,
              id: `<part-id:${event.event.properties.part.type}>`,
              messageID: '<message-id>',
            },
          },
        },
      };
    }

    if (event.event?.type === 'message.part.delta') {
      return {
        ...event,
        event: {
          ...event.event,
          properties: {
            ...event.event.properties,
            messageID: '<message-id>',
            partID: '<part-id:text>',
          },
        },
      };
    }

    return event;
  });
}

test('synthetic assistant reply sender emits canonical reply events using input text', () => {
  const sent = [];
  const sender = new SyntheticAssistantReplySender(
    {
      sendIfActive: (_connection, payload, context) => {
        sent.push({ payload, context });
        return true;
      },
    },
    (message) => message,
  );
  const connection = { send: () => undefined };
  const logger = createLogger();
  let toolDoneCalls = 0;

  const result = sender.execute({
    connection,
    toolSessionId: 'tool-synthetic-1',
    welinkSessionId: 'wl-synthetic-1',
    text: '这是本地合成回复',
    logger,
    traceId: 'bridge-trace-1',
    gatewayMessageId: 'gateway-msg-1',
    action: 'chat',
    sendToolDone: (toolSessionId, welinkSessionId) => {
      toolDoneCalls += 1;
      assert.strictEqual(toolSessionId, 'tool-synthetic-1');
      assert.strictEqual(welinkSessionId, 'wl-synthetic-1');
      return true;
    },
  });

  assert.deepStrictEqual(result, { success: true });
  assert.strictEqual(toolDoneCalls, 1);
  assert.strictEqual(sent.length, 6);

  const [messageUpdated, stepStart, textSeedUpdated, textDelta, textFinalUpdated, stepFinish] = sent.map((entry) => entry.payload);
  assert.strictEqual(messageUpdated.type, 'tool_event');
  assert.strictEqual(messageUpdated.event.type, 'message.updated');
  assert.match(messageUpdated.event.properties.info.id, /^msg_[a-f0-9]{32}$/);

  const messageId = messageUpdated.event.properties.info.id;
  const partIds = [
    stepStart.event.properties.part.id,
    textSeedUpdated.event.properties.part.id,
    textDelta.event.properties.partID,
    textFinalUpdated.event.properties.part.id,
    stepFinish.event.properties.part.id,
  ];
  assert.ok(partIds.every((id) => /^prt_[a-f0-9]{32}$/.test(id)));
  assert.strictEqual(new Set(partIds).size, 3);
  assert.strictEqual(textSeedUpdated.event.properties.part.text, '');
  assert.strictEqual(textDelta.event.properties.delta, '这是本地合成回复');
  assert.strictEqual(textFinalUpdated.event.properties.part.text, '这是本地合成回复');
  assert.strictEqual(stepStart.event.properties.part.messageID, messageId);
  assert.strictEqual(textSeedUpdated.event.properties.part.messageID, messageId);
  assert.strictEqual(textDelta.event.properties.messageID, messageId);
  assert.strictEqual(textFinalUpdated.event.properties.part.messageID, messageId);
  assert.strictEqual(stepFinish.event.properties.part.messageID, messageId);
  assert.strictEqual(stepFinish.event.properties.part.reason, 'stop');
});

test('synthetic assistant reply sender fails closed when text event validation fails', () => {
  const sent = [];
  const sender = new SyntheticAssistantReplySender(
    {
      sendIfActive: (_connection, payload) => {
        sent.push(payload);
        return true;
      },
    },
    (message) => {
      if (message.type === 'tool_event' && message.event.type === 'message.part.delta') {
        return null;
      }
      return message;
    },
  );

  const result = sender.execute({
    connection: { send: () => undefined },
    toolSessionId: 'tool-synthetic-2',
    welinkSessionId: 'wl-synthetic-2',
    text: '不会完整发送',
    logger: createLogger(),
    traceId: 'bridge-trace-2',
    gatewayMessageId: 'gateway-msg-2',
    action: 'chat',
    sendToolDone: () => {
      assert.fail('sendToolDone should not be called when synthetic text event validation fails');
    },
  });

  assert.deepStrictEqual(result, {
    success: false,
    failureStage: 'message.part.delta.text',
  });
  assert.strictEqual(sent.length, 3);
});

test('slash projector and synthetic sender stay aligned with the canonical builder shape', () => {
  const builder = new SyntheticAssistantReplySequenceBuilder();
  const canonical = builder.build({
    toolSessionId: 'tool-parity-1',
    text: '统一回复',
  });
  const canonicalEvents = [
    canonical.messageUpdated,
    canonical.stepStart,
    canonical.textSeedUpdated,
    canonical.textDelta,
    canonical.textFinalUpdated,
    canonical.stepFinish,
  ];

  const projector = new MemoryGatewayEnvelopeProjector();
  const projected = projector.projectSyntheticAssistantReply({
    anchor: 'tool-parity-1',
    text: '统一回复',
  });

  const sent = [];
  const sender = new SyntheticAssistantReplySender(
    {
      sendIfActive: (_connection, payload) => {
        sent.push(payload);
        return true;
      },
    },
    (message) => message,
  );
  const result = sender.execute({
    connection: { send: () => undefined },
    toolSessionId: 'tool-parity-1',
    text: '统一回复',
    logger: createLogger(),
    traceId: 'trace-parity-1',
    action: 'chat',
    sendToolDone: () => true,
  });

  assert.deepStrictEqual(result, { success: true });
  assert.deepStrictEqual(
    normalizeSyntheticReplyEvents(projected),
    normalizeSyntheticReplyEvents(canonicalEvents),
  );
  assert.deepStrictEqual(
    normalizeSyntheticReplyEvents(sent),
    normalizeSyntheticReplyEvents(canonicalEvents),
  );
});
