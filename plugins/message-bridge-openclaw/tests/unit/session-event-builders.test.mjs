import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAssistantMessageUpdated,
  buildAssistantPartDelta,
  buildAssistantPartUpdated,
  buildBusyEvent,
  buildIdleEvent,
  buildSessionErrorEvent,
  buildToolPartUpdated,
  createToolSessionId,
} from "../../src/session/upstreamEvents.ts";

test("createToolSessionId generates ses_ prefixed ids", () => {
  const sessionId = createToolSessionId();

  assert.match(sessionId, /^ses_/);
});

test("session lifecycle events keep payload sessionID aligned with toolSessionId", () => {
  const toolSessionId = "ses_tool_1";

  assert.equal(buildBusyEvent(toolSessionId).properties.sessionID, toolSessionId);
  assert.equal(buildIdleEvent(toolSessionId).properties.sessionID, toolSessionId);
  assert.equal(buildSessionErrorEvent(toolSessionId, "boom").properties.sessionID, toolSessionId);
});

test("assistant message events use toolSessionId inside payload", () => {
  const toolSessionId = "ses_tool_2";
  const messageUpdated = buildAssistantMessageUpdated(toolSessionId, "msg_1");
  const partUpdated = buildAssistantPartUpdated(toolSessionId, "msg_1", "part_1", "hello", "he");
  const partDelta = buildAssistantPartDelta(toolSessionId, "msg_1", "part_1", "llo");

  assert.equal(messageUpdated.properties.info.sessionID, toolSessionId);
  assert.equal(partUpdated.properties.part.sessionID, toolSessionId);
  assert.equal(partDelta.properties.sessionID, toolSessionId);
});

test("tool part events use toolSessionId instead of internal sessionKey", () => {
  const event = buildToolPartUpdated({
    toolSessionId: "ses_tool_3",
    toolCallId: "call_1",
    toolName: "search",
    partId: "part_2",
    messageId: "msg_2",
    status: "running",
  });

  assert.equal(event.properties.part.sessionID, "ses_tool_3");
});
