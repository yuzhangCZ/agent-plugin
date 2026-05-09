import test from 'node:test';
import assert from 'node:assert/strict';

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
  assert.strictEqual(sent.length, 4);

  const [messageUpdated, stepStart, text, stepFinish] = sent.map((entry) => entry.payload);
  assert.strictEqual(messageUpdated.type, 'tool_event');
  assert.strictEqual(messageUpdated.event.type, 'message.updated');
  assert.match(messageUpdated.event.properties.info.id, /^msg_[a-f0-9]{32}$/);

  const messageId = messageUpdated.event.properties.info.id;
  const partIds = [
    stepStart.event.properties.part.id,
    text.event.properties.part.id,
    stepFinish.event.properties.part.id,
  ];
  assert.ok(partIds.every((id) => /^prt_[a-f0-9]{32}$/.test(id)));
  assert.strictEqual(new Set(partIds).size, 3);
  assert.strictEqual(text.event.properties.part.text, '这是本地合成回复');
  assert.strictEqual(stepStart.event.properties.part.messageID, messageId);
  assert.strictEqual(text.event.properties.part.messageID, messageId);
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
      if (message.type === 'tool_event' && message.event.type === 'message.part.updated' && message.event.properties.part.type === 'text') {
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
    failureStage: 'message.part.updated.text',
  });
  assert.strictEqual(sent.length, 2);
});
