import { randomUUID } from "node:crypto";

export interface ToolPartEventState {
  toolSessionId: string;
  toolCallId: string;
  toolName: string;
  partId: string;
  messageId: string;
  status: "running" | "completed" | "error";
  time?: number;
  output?: string;
  error?: string;
  title?: string;
}

export interface MessageUpdatedTime {
  created: number;
  completed?: number;
}

export interface SessionUpdatedInfo {
  id: string;
  title: string;
  time: {
    created: number;
    updated: number;
  };
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
}

export interface StepPartOptions {
  time?: number;
  reason?: string;
  snapshot?: string;
  tokens?: Record<string, unknown>;
  cost?: number;
}

export interface ReasoningPartOptions {
  start: number;
  end?: number;
  metadata?: Record<string, unknown>;
}

export interface TextPartOptions {
  delta?: string;
  time?: number;
}

export function createToolSessionId(): string {
  return `ses_${randomUUID()}`;
}

export function buildBusyEvent(toolSessionId: string): Record<string, unknown> {
  return {
    type: "session.status",
    properties: {
      sessionID: toolSessionId,
      status: {
        type: "busy",
      },
    },
  };
}

export function buildIdleEvent(toolSessionId: string): Record<string, unknown> {
  return {
    type: "session.idle",
    properties: {
      sessionID: toolSessionId,
    },
  };
}

export function buildSessionErrorEvent(toolSessionId: string, error: string): Record<string, unknown> {
  return {
    type: "session.error",
    properties: {
      sessionID: toolSessionId,
      error: {
        message: error,
      },
    },
  };
}

export function buildMessageUpdated(
  toolSessionId: string,
  messageId: string,
  role: "user" | "assistant",
  time: MessageUpdatedTime,
): Record<string, unknown> {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: messageId,
        sessionID: toolSessionId,
        role,
        time,
      },
    },
  };
}

export function buildAssistantMessageUpdated(toolSessionId: string, messageId: string): Record<string, unknown> {
  return buildMessageUpdated(toolSessionId, messageId, "assistant", {
    created: Date.now(),
  });
}

export function buildSessionUpdated(toolSessionId: string, info: SessionUpdatedInfo): Record<string, unknown> {
  return {
    type: "session.updated",
    properties: {
      sessionID: toolSessionId,
      info,
    },
  };
}

export function buildTextPartUpdated(
  toolSessionId: string,
  messageId: string,
  partId: string,
  text: string,
  options: TextPartOptions = {},
): Record<string, unknown> {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: toolSessionId,
      ...(options.delta !== undefined ? { delta: options.delta } : {}),
      ...(options.time !== undefined ? { time: options.time } : {}),
      part: {
        id: partId,
        sessionID: toolSessionId,
        messageID: messageId,
        type: "text",
        text,
      },
    },
  };
}

export function buildAssistantPartUpdated(
  toolSessionId: string,
  messageId: string,
  partId: string,
  text: string,
  delta?: string,
): Record<string, unknown> {
  return buildTextPartUpdated(toolSessionId, messageId, partId, text, { delta });
}

export function buildMessagePartDelta(
  toolSessionId: string,
  messageId: string,
  partId: string,
  delta: string,
): Record<string, unknown> {
  return {
    type: "message.part.delta",
    properties: {
      sessionID: toolSessionId,
      messageID: messageId,
      partID: partId,
      field: "text",
      delta,
    },
  };
}

export function buildAssistantPartDelta(
  toolSessionId: string,
  messageId: string,
  partId: string,
  delta: string,
): Record<string, unknown> {
  return buildMessagePartDelta(toolSessionId, messageId, partId, delta);
}

export function buildStepStartPartUpdated(
  toolSessionId: string,
  messageId: string,
  partId: string,
  options: StepPartOptions = {},
): Record<string, unknown> {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: toolSessionId,
      ...(options.time !== undefined ? { time: options.time } : {}),
      part: {
        id: partId,
        sessionID: toolSessionId,
        messageID: messageId,
        type: "step-start",
        ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
      },
    },
  };
}

export function buildReasoningPartUpdated(
  toolSessionId: string,
  messageId: string,
  partId: string,
  text: string,
  options: ReasoningPartOptions,
): Record<string, unknown> {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: toolSessionId,
      ...(options.end !== undefined ? { time: options.end } : { time: options.start }),
      part: {
        id: partId,
        sessionID: toolSessionId,
        messageID: messageId,
        type: "reasoning",
        text,
        time: {
          start: options.start,
          ...(options.end !== undefined ? { end: options.end } : {}),
        },
        ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      },
    },
  };
}

export function buildStepFinishPartUpdated(
  toolSessionId: string,
  messageId: string,
  partId: string,
  options: StepPartOptions = {},
): Record<string, unknown> {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: toolSessionId,
      ...(options.time !== undefined ? { time: options.time } : {}),
      part: {
        id: partId,
        sessionID: toolSessionId,
        messageID: messageId,
        type: "step-finish",
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
        ...(options.tokens !== undefined ? { tokens: options.tokens } : {}),
        ...(options.cost !== undefined ? { cost: options.cost } : {}),
      },
    },
  };
}

export function buildToolPartUpdated(
  state: ToolPartEventState,
): Record<string, unknown> {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: state.toolSessionId,
      ...(state.time !== undefined ? { time: state.time } : {}),
      part: {
        id: state.partId,
        sessionID: state.toolSessionId,
        messageID: state.messageId,
        type: "tool",
        tool: state.toolName,
        callID: state.toolCallId,
        state: {
          status: state.status,
          ...(state.output !== undefined ? { output: state.output } : {}),
          ...(state.error !== undefined ? { error: state.error } : {}),
          ...(state.title !== undefined ? { title: state.title } : {}),
        },
      },
    },
  };
}
