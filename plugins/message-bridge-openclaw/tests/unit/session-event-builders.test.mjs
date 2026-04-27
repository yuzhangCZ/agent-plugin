import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBusyEvent,
  buildIdleEvent,
  buildMessagePartDelta,
  buildMessageUpdated,
  buildSessionUpdated,
  buildSessionErrorEvent,
  buildStepFinishPartUpdated,
  buildStepStartPartUpdated,
  buildTextPartUpdated,
  buildToolPartUpdated,
  buildReasoningPartUpdated,
  buildPermissionAskedEvent,
  buildPermissionUpdatedEvent,
  buildQuestionAskedEvent,
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

test("message.updated supports user and assistant lifecycle payloads", () => {
  const toolSessionId = "ses_tool_2";
  const userUpdated = buildMessageUpdated(toolSessionId, "msg_user_1", "user", { created: 101 });
  const assistantUpdated = buildMessageUpdated(toolSessionId, "msg_assistant_1", "assistant", {
    created: 102,
    completed: 110,
  });

  assert.equal(userUpdated.properties.info.role, "user");
  assert.equal(userUpdated.properties.info.time.created, 101);
  assert.equal(userUpdated.properties.info.sessionID, toolSessionId);
  assert.equal(assistantUpdated.properties.info.role, "assistant");
  assert.equal(assistantUpdated.properties.info.time.created, 102);
  assert.equal(assistantUpdated.properties.info.time.completed, 110);
  assert.equal(assistantUpdated.properties.info.sessionID, toolSessionId);
});

test("session.updated keeps sessionID and info payload aligned", () => {
  const event = buildSessionUpdated("ses_tool_9", {
    id: "ses_tool_9",
    title: "Session Title",
    time: {
      created: 200,
      updated: 300,
    },
  });

  assert.equal(event.properties.sessionID, "ses_tool_9");
  assert.equal(event.properties.info.id, "ses_tool_9");
  assert.equal(event.properties.info.title, "Session Title");
  assert.equal(event.properties.info.time.created, 200);
  assert.equal(event.properties.info.time.updated, 300);
});

test("text, step, reasoning and delta builders share message/session identity", () => {
  const toolSessionId = "ses_tool_4";
  const stepStart = buildStepStartPartUpdated(toolSessionId, "msg_4", "step_start_1", { time: 401 });
  const reasoning = buildReasoningPartUpdated(toolSessionId, "msg_4", "reason_1", "", {
    start: 402,
  });
  const text = buildTextPartUpdated(toolSessionId, "msg_4", "text_1", "hello", {
    delta: "he",
    time: 403,
  });
  const delta = buildMessagePartDelta(toolSessionId, "msg_4", "text_1", "llo");
  const stepFinish = buildStepFinishPartUpdated(toolSessionId, "msg_4", "step_finish_1", {
    time: 404,
  });

  assert.equal(stepStart.properties.sessionID, toolSessionId);
  assert.equal(stepStart.properties.part.type, "step-start");
  assert.equal(stepStart.properties.part.messageID, "msg_4");
  assert.equal(stepStart.properties.time, 401);

  assert.equal(reasoning.properties.sessionID, toolSessionId);
  assert.equal(reasoning.properties.part.type, "reasoning");
  assert.equal(reasoning.properties.part.text, "");
  assert.equal(reasoning.properties.part.time.start, 402);

  assert.equal(text.properties.sessionID, toolSessionId);
  assert.equal(text.properties.part.type, "text");
  assert.equal(text.properties.part.id, "text_1");
  assert.equal(text.properties.part.messageID, "msg_4");
  assert.equal(text.properties.delta, "he");
  assert.equal(text.properties.time, 403);

  assert.equal(delta.properties.sessionID, toolSessionId);
  assert.equal(delta.properties.messageID, "msg_4");
  assert.equal(delta.properties.partID, "text_1");
  assert.equal(delta.properties.field, "text");
  assert.equal(delta.properties.delta, "llo");

  assert.equal(stepFinish.properties.sessionID, toolSessionId);
  assert.equal(stepFinish.properties.part.type, "step-finish");
  assert.equal(stepFinish.properties.part.messageID, "msg_4");
  assert.equal(stepFinish.properties.time, 404);
});

test("tool part events use toolSessionId instead of internal sessionKey", () => {
  const event = buildToolPartUpdated({
    toolSessionId: "ses_tool_3",
    toolCallId: "call_1",
    toolName: "search",
    partId: "part_2",
    messageId: "msg_2",
    status: "running",
    time: 405,
  });

  assert.equal(event.properties.sessionID, "ses_tool_3");
  assert.equal(event.properties.time, 405);
  assert.equal(event.properties.part.sessionID, "ses_tool_3");
  assert.equal(event.properties.part.messageID, "msg_2");
  assert.equal(event.properties.part.id, "part_2");
  assert.equal(event.properties.part.type, "tool");
});

test("permission and question events use gateway-compatible payload shape", () => {
  const permissionAsked = buildPermissionAskedEvent("ses_tool_perm", "perm_1", {
    title: "Run command",
    messageId: "msg_perm_1",
    metadata: { command: "ls" },
    sourceEvent: "exec.approval.requested",
  });
  const permissionUpdated = buildPermissionUpdatedEvent("ses_tool_perm", "perm_1", {
    status: "resolved",
    decision: "allow-once",
    resolvedAt: 501,
    sourceEvent: "exec.approval.resolved",
  });
  const questionAsked = buildQuestionAskedEvent("ses_tool_q", {
    requestId: "question_1",
    messageId: "msg_q_1",
    toolCallId: "call_q_1",
    questions: [
      {
        question: "Choose a framework",
        header: "Framework",
        options: [{ label: "Vite" }],
      },
    ],
  });

  assert.equal(permissionAsked.type, "permission.asked");
  assert.equal(permissionAsked.properties.id, "perm_1");
  assert.equal(permissionAsked.properties.sessionID, "ses_tool_perm");
  assert.equal(permissionAsked.properties.title, "Run command");
  assert.equal(permissionAsked.properties.metadata.command, "ls");

  assert.equal(permissionUpdated.type, "permission.updated");
  assert.equal(permissionUpdated.properties.id, "perm_1");
  assert.equal(permissionUpdated.properties.status, "resolved");
  assert.equal(permissionUpdated.properties.decision, "allow-once");
  assert.equal(permissionUpdated.properties.resolvedAt, 501);

  assert.equal(questionAsked.type, "question.asked");
  assert.equal(questionAsked.properties.id, "question_1");
  assert.equal(questionAsked.properties.sessionID, "ses_tool_q");
  assert.equal(questionAsked.properties.tool.callID, "call_q_1");
  assert.equal(questionAsked.properties.questions[0].header, "Framework");
});
