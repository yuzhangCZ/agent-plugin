import assert from 'node:assert/strict';

function assertNoField(message, fieldName) {
  assert.strictEqual(fieldName in message, false, `${fieldName} should be absent`);
}

export function assertToolDoneShape(message, expected = {}) {
  assert.strictEqual(message.type, 'tool_done');
  if ('welinkSessionId' in expected) assert.strictEqual(message.welinkSessionId, expected.welinkSessionId);
  if ('toolSessionId' in expected) assert.strictEqual(message.toolSessionId, expected.toolSessionId);
  if ('reason' in expected) assert.strictEqual(message.reason, expected.reason);
}

export function assertSessionCreatedShape(message, expected = {}) {
  assert.strictEqual(message.type, 'session_created');
  if ('welinkSessionId' in expected) assert.strictEqual(message.welinkSessionId, expected.welinkSessionId);
  if ('toolSessionId' in expected) assert.strictEqual(message.toolSessionId, expected.toolSessionId);
}

export function assertStatusResponseShape(message, expected = {}) {
  assert.strictEqual(message.type, 'status_response');
  if ('opencodeOnline' in expected) assert.strictEqual(message.opencodeOnline, expected.opencodeOnline);
  if (expected.envelopeFree === true) {
    assertNoField(message, 'welinkSessionId');
    assertNoField(message, 'sessionId');
  }
}

export function assertToolErrorShape(message, expected = {}) {
  assert.strictEqual(message.type, 'tool_error');
  if ('welinkSessionId' in expected) assert.strictEqual(message.welinkSessionId, expected.welinkSessionId);
  if ('toolSessionId' in expected) assert.strictEqual(message.toolSessionId, expected.toolSessionId);
  if ('error' in expected) assert.strictEqual(message.error, expected.error);
  if ('reason' in expected) assert.strictEqual(message.reason, expected.reason);
  if ('hasCode' in expected) {
    assert.strictEqual('code' in message, expected.hasCode);
  }
}

export function createInvalidInvokeInboundFrame(overrides = {}) {
  return {
    kind: 'invalid',
    messageType: 'invoke',
    gatewayMessageId: 'gw-invalid-1',
    action: 'chat',
    welinkSessionId: 'wl-invalid-1',
    toolSessionId: 'tool-invalid-1',
    violation: {
      violation: {
        stage: 'payload',
        code: 'missing_required_field',
        field: 'payload.text',
        message: 'payload.text is required',
        messageType: 'invoke',
        action: 'chat',
        welinkSessionId: 'wl-invalid-1',
        toolSessionId: 'tool-invalid-1',
      },
    },
    rawPreview: {
      type: 'invoke',
      messageId: 'gw-invalid-1',
      action: 'chat',
      welinkSessionId: 'wl-invalid-1',
      payload: {
        toolSessionId: 'tool-invalid-1',
      },
    },
    ...overrides,
  };
}

export function assertInvalidInvokeToolErrorContract(message, expected = {}) {
  const code = expected.code ?? 'missing_required_field';
  assertToolErrorShape(message, {
    welinkSessionId: expected.welinkSessionId,
    toolSessionId: expected.toolSessionId,
    error: expected.error ?? `gateway_invalid_invoke:${code}`,
    reason: expected.reason,
    hasCode: false,
  });
}

export function assertNormalizedDownstreamInvokeShape(message, expected = {}) {
  assert.strictEqual(message.type, 'invoke');
  if ('action' in expected) assert.strictEqual(message.action, expected.action);
  if ('welinkSessionId' in expected) assert.strictEqual(message.welinkSessionId, expected.welinkSessionId);
  if ('payload' in expected) assert.deepStrictEqual(message.payload, expected.payload);
  if (expected.hasLegacySessionFields === false && message.action === 'create_session') {
    assertNoField(message.payload, 'sessionId');
    assertNoField(message.payload, 'metadata');
  }
}

export function assertToolEventShape(message, expected = {}) {
  assert.strictEqual(message.type, 'tool_event');
  if ('toolSessionId' in expected) assert.strictEqual(message.toolSessionId, expected.toolSessionId);
  if ('eventType' in expected) assert.strictEqual(message.event?.type, expected.eventType);
}

export function assertSimpleToolEventShape(message, expected = {}) {
  assert.strictEqual(message.type, expected.type);
  if ('properties' in expected) assert.deepStrictEqual(message.properties, expected.properties);
}

export function assertWireViolationShape(message, expected = {}) {
  const violation = message?.violation ?? message;
  assert.strictEqual(typeof message, 'object');
  assert.ok(violation);
  if ('stage' in expected) assert.strictEqual(violation.stage, expected.stage);
  if ('code' in expected) assert.strictEqual(violation.code, expected.code);
  if ('field' in expected) assert.strictEqual(violation.field, expected.field);
  if ('message' in expected) assert.strictEqual(violation.message, expected.message);
  if ('messageType' in expected) assert.strictEqual(violation.messageType, expected.messageType);
  if ('action' in expected) assert.strictEqual(violation.action, expected.action);
  if ('eventType' in expected) assert.strictEqual(violation.eventType, expected.eventType);
  if ('welinkSessionId' in expected) assert.strictEqual(violation.welinkSessionId, expected.welinkSessionId);
  if ('toolSessionId' in expected) assert.strictEqual(violation.toolSessionId, expected.toolSessionId);
}

export function assertProjectedMessageUpdatedShape(message, expected = {}) {
  assert.strictEqual(message.type, 'message.updated');
  const info = message.properties?.info;
  if (!info) {
    assert.fail('message.updated should include properties.info');
  }

  if ('id' in expected) assert.strictEqual(info.id, expected.id);
  if ('sessionID' in expected) assert.strictEqual(info.sessionID, expected.sessionID);
  if ('role' in expected) assert.strictEqual(info.role, expected.role);
  if ('created' in expected) assert.strictEqual(info.time.created, expected.created);
  if ('updated' in expected) assert.strictEqual(info.time.updated, expected.updated);
  if ('model' in expected) assert.deepStrictEqual(info.model, expected.model);
  if ('finishReason' in expected) assert.strictEqual(info.finish?.reason, expected.finishReason);

  const summary = message.properties?.info?.summary;
  if ('hasSummary' in expected) {
    assert.strictEqual(!!summary, expected.hasSummary);
  }
  if (!summary) {
    return;
  }
  if ('files' in expected) assert.strictEqual(summary.files, expected.files);
  if ('additions' in expected) assert.strictEqual(summary.additions, expected.additions);
  if ('deletions' in expected) assert.strictEqual(summary.deletions, expected.deletions);
  if ('diffCount' in expected) assert.strictEqual(summary.diffs?.length ?? 0, expected.diffCount);
  if (Array.isArray(summary.diffs) && summary.diffs.length > 0) {
    for (const diff of summary.diffs) {
      assert.strictEqual('before' in diff, false);
      assert.strictEqual('after' in diff, false);
    }
  }
}

export function assertMessagePartUpdatedShape(message, expected = {}) {
  assert.strictEqual(message.type, 'message.part.updated');
  const part = message.properties?.part;
  if (!part) {
    assert.fail('message.part.updated should include properties.part');
  }

  if ('partType' in expected) assert.strictEqual(part.type, expected.partType);
  if ('part' in expected) assert.deepStrictEqual(part, expected.part);
  if ('delta' in expected) assert.strictEqual(message.properties.delta, expected.delta);
  if (expected.hasDelta === false) {
    assert.strictEqual('delta' in message.properties, false);
  }
}

export function assertNoSuccessMessageOnInvalidInput(messages) {
  const successTypes = new Set(['tool_done', 'status_response', 'session_created']);
  assert.strictEqual(messages.some((message) => successTypes.has(message?.type)), false);
}
