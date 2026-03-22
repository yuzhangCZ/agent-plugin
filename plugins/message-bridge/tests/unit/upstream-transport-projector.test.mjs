import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultUpstreamTransportProjector } from '../../src/transport/upstream/index.ts';
import { createLargeMessageUpdatedEvent } from '../fixtures/opencode-events/message.updated.large-summary.fixture.mjs';

function createProjector() {
  return new DefaultUpstreamTransportProjector();
}

describe('upstream transport projection', () => {
  test('projects message.updated into a lightweight transport shape', () => {
    const projector = createProjector();
    const raw = createLargeMessageUpdatedEvent();
    const projected = projector.project({
      common: {
        eventType: 'message.updated',
        toolSessionId: 'ses_large_summary_fixture',
      },
      extra: {
        kind: 'message.updated',
        messageId: 'msg_large_summary_fixture',
        role: 'user',
      },
      raw,
    });

    assert.strictEqual(projected.type, 'message.updated');
    assert.deepStrictEqual(projected.properties.info.summary, {
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
    assert.ok(!('before' in projected.properties.info.summary.diffs[0]));
    assert.ok(!('after' in projected.properties.info.summary.diffs[0]));
    assert.ok(!('before' in projected.properties.info.summary.diffs[1]));
    assert.ok(!('after' in projected.properties.info.summary.diffs[1]));
  });

  test('passes through non-message.updated events unchanged', () => {
    const projector = createProjector();
    const raw = {
      type: 'session.status',
      properties: {
        sessionID: 'ses_status_fixture',
        status: {
          type: 'busy',
        },
      },
    };

    const projected = projector.project({
      common: {
        eventType: 'session.status',
        toolSessionId: 'ses_status_fixture',
      },
      extra: {
        kind: 'session.status',
        status: 'busy',
      },
      raw,
    });

    assert.strictEqual(projected, raw);
  });

  test('does not mutate the original raw event while projecting message.updated', () => {
    const projector = createProjector();
    const raw = createLargeMessageUpdatedEvent();
    const original = structuredClone(raw);

    const projected = projector.project({
      common: {
        eventType: 'message.updated',
        toolSessionId: 'ses_large_summary_fixture',
      },
      extra: {
        kind: 'message.updated',
        messageId: 'msg_large_summary_fixture',
        role: 'user',
      },
      raw,
    });

    assert.strictEqual(projected.type, 'message.updated');
    assert.deepStrictEqual(raw, original);
  });
});
