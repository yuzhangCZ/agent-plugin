import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMessageDoneFact,
  buildMessageStartFact,
  buildPermissionAskFact,
  buildQuestionAskFact,
  buildSessionErrorFact,
  buildTextDeltaFact,
  buildTextDoneFact,
  buildToolUpdateFact,
  createToolSessionId,
} from "../../src/session/facts.ts";

test("createToolSessionId generates ses_ prefixed ids", () => {
  const toolSessionId = createToolSessionId();

  assert.match(toolSessionId, /^ses_/);
});

test("session fact builders keep stable ids on toolSessionId", () => {
  const toolSessionId = "ses_tool_1";
  const messageStart = buildMessageStartFact({ toolSessionId, messageId: "msg_1" });
  const textDelta = buildTextDeltaFact({
    toolSessionId,
    messageId: "msg_1",
    partId: "part_1",
    content: "he",
  });
  const textDone = buildTextDoneFact({
    toolSessionId,
    messageId: "msg_1",
    partId: "part_1",
    content: "hello",
  });
  const toolUpdate = buildToolUpdateFact({
    toolSessionId,
    messageId: "msg_1",
    partId: "tool_1",
    toolCallId: "call_1",
    toolName: "search",
    status: "running",
  });
  const questionAsk = buildQuestionAskFact({
    toolSessionId,
    messageId: "msg_1",
    toolCallId: "call_2",
    question: "continue?",
  });
  const permissionAsk = buildPermissionAskFact({
    toolSessionId,
    messageId: "msg_1",
    permissionId: "perm_1",
  });
  const messageDone = buildMessageDoneFact({ toolSessionId, messageId: "msg_1" });
  const sessionError = buildSessionErrorFact({
    toolSessionId,
    error: {
      code: "internal_error",
      message: "boom",
    },
  });

  for (const fact of [
    messageStart,
    textDelta,
    textDone,
    toolUpdate,
    questionAsk,
    permissionAsk,
    messageDone,
    sessionError,
  ]) {
    assert.equal(fact.toolSessionId, toolSessionId);
    assert.equal("sessionKey" in fact, false);
  }
});
