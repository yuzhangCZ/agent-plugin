import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts';
import { EventFilter } from '../../src/event/EventFilter.ts';
import { createLargeMessageUpdatedEvent } from '../fixtures/opencode-events/message.updated.large-summary.fixture.mjs';

describe('event uplink via hook boundary', () => {
  test('session.created is handled as an internal control event and is not forwarded', async () => {
    const logs = [];
    const runtime = new BridgeRuntime({
      client: {
        app: {
          log: async (options) => {
            logs.push(options);
            return true;
          },
        },
      },
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    runtime.eventFilter = new EventFilter(['session.idle']);
    runtime.stateManager.setState('READY');

    await runtime.handleEvent({
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_child_1',
          parentID: 'ses_parent_1',
          title: 'research-agent',
        },
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(sent.length, 0);
    const warnEntry = logs.find((item) => item?.body?.message === 'event.extraction_failed');
    assert.strictEqual(warnEntry, undefined);
  });

  test('allowed event sends tool_event', async () => {
    const runtime = new BridgeRuntime({ client: {} });
    const sent = [];

    runtime.gatewayConnection = { send: (msg, ctx) => sent.push({ msg, ctx }) };
    runtime.eventFilter = new EventFilter(['message.updated']);
    runtime.stateManager.setState('READY');

    await runtime.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-1',
          sessionID: 'tool-1',
          role: 'user',
        },
      },
    });

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].msg.type, 'tool_event');
    assert.strictEqual(sent[0].msg.toolSessionId, 'tool-1');
    assert.strictEqual(sent[0].msg.event.type, 'message.updated');
    assert.strictEqual('sessionId' in sent[0].msg, false);
    assert.strictEqual('envelope' in sent[0].msg, false);
  });

  test('message.updated prunes summary before sending but keeps lightweight diff metadata', async () => {
    const runtime = new BridgeRuntime({ client: {} });
    const sent = [];
    const event = createLargeMessageUpdatedEvent();
    const originalEvent = structuredClone(event);

    runtime.gatewayConnection = { send: (msg, ctx) => sent.push({ msg, ctx }) };
    runtime.eventFilter = new EventFilter(['message.updated']);
    runtime.stateManager.setState('READY');

    await runtime.handleEvent(event);

    assert.strictEqual(sent.length, 1);
    const [{ msg, ctx }] = sent;
    assert.strictEqual(msg.type, 'tool_event');
    assert.strictEqual(msg.toolSessionId, 'ses_large_summary_fixture');
    assert.strictEqual(msg.event.type, 'message.updated');
    assert.deepStrictEqual(msg.event.properties.info.summary, {
      additions: 1227,
      deletions: 0,
      files: 2,
      diffs: [
        {
          file: 'logs/local-stack/ai-gateway.log',
          status: 'modified',
          additions: 829,
          deletions: 0,
        },
        {
          file: 'logs/local-stack/skill-server.log',
          status: 'modified',
          additions: 398,
          deletions: 0,
        },
      ],
    });
    assert.ok(ctx.originalPayloadBytes > 1024 * 1024);
    assert.ok(ctx.transportPayloadBytes < 256 * 1024);
    assert.ok(ctx.transportPayloadBytes / ctx.originalPayloadBytes < 0.2);
    assert.strictEqual(event.properties.info.summary.diffs[0].before, originalEvent.properties.info.summary.diffs[0].before);
    assert.strictEqual(event.properties.info.summary.diffs[0].after, originalEvent.properties.info.summary.diffs[0].after);
    assert.strictEqual(event.properties.info.summary.diffs[1].before, originalEvent.properties.info.summary.diffs[1].before);
    assert.strictEqual(event.properties.info.summary.diffs[1].after, originalEvent.properties.info.summary.diffs[1].after);
  });

  test('missing required upstream field fails closed', async () => {
    const logs = [];
    const runtime = new BridgeRuntime({
      client: {
        app: {
          log: async (options) => {
            logs.push(options);
            return true;
          },
        },
      },
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    runtime.eventFilter = new EventFilter(['message.updated']);
    runtime.stateManager.setState('READY');

    await runtime.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-missing-session',
          role: 'user',
        },
      },
    });

    assert.strictEqual(sent.length, 0);
    const warnEntry = logs.find((item) => item?.body?.message === 'event.extraction_failed');
    assert.ok(!!warnEntry);
  });
});
