import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMessageDoneFact,
  buildMessageStartFact,
  buildPermissionAskFact,
  buildSessionErrorFact,
  buildThinkingDeltaFact,
  buildThinkingDoneFact,
  buildTextDeltaFact,
  buildTextDoneFact,
  buildToolUpdateFact,
  createToolSessionId,
} from "../../src/session/facts.ts";

test("createToolSessionId generates ses_ prefixed ids", () => {
  const toolSessionId = createToolSessionId();

  assert.match(toolSessionId, /^ses_/);
});

test("session fact builders keep fact payloads free of session ownership fields", () => {
  const messageStart = buildMessageStartFact({ messageId: "msg_1" });
  const textDelta = buildTextDeltaFact({
    messageId: "msg_1",
    partId: "part_1",
    content: "he",
  });
  const textDone = buildTextDoneFact({
    messageId: "msg_1",
    partId: "part_1",
    content: "hello",
  });
  const thinkingDelta = buildThinkingDeltaFact({
    messageId: "msg_1",
    partId: "think_1",
    content: "thinking",
  });
  const thinkingDone = buildThinkingDoneFact({
    messageId: "msg_1",
    partId: "think_1",
    content: "thinking",
  });
  const toolUpdate = buildToolUpdateFact({
    messageId: "msg_1",
    partId: "tool_1",
    toolCallId: "call_1",
    toolName: "search",
    status: "running",
    input: {
      query: "docs",
    },
  });
  const permissionAsk = buildPermissionAskFact({
    messageId: "msg_1",
    partId: "part_perm_1",
    permissionId: "perm_1",
    permissionType: "exec",
    title: "Run command?",
    metadata: {
      command: "echo hi",
    },
  });
  const messageDone = buildMessageDoneFact({ messageId: "msg_1" });
  const sessionError = buildSessionErrorFact({
    error: {
      code: "internal_error",
      message: "boom",
    },
  });

  for (const fact of [
    messageStart,
    textDelta,
    textDone,
    thinkingDelta,
    thinkingDone,
    toolUpdate,
    permissionAsk,
    messageDone,
    sessionError,
  ]) {
    assert.equal("toolSessionId" in fact, false);
    assert.equal("sessionKey" in fact, false);
  }

  assert.equal(permissionAsk.partId, "part_perm_1");
  assert.equal(permissionAsk.title, "Run command?");
  assert.deepEqual(permissionAsk.metadata, { command: "echo hi" });
  assert.equal(toolUpdate.input, '{"query":"docs"}');
});
