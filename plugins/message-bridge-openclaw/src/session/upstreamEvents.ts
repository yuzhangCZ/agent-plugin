import { randomUUID } from "node:crypto";

export interface ToolPartEventState {
  toolSessionId: string;
  toolCallId: string;
  toolName: string;
  partId: string;
  messageId: string;
  status: "running" | "completed" | "error";
  output?: string;
  error?: string;
  title?: string;
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

export function buildAssistantMessageUpdated(toolSessionId: string, messageId: string): Record<string, unknown> {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: messageId,
        sessionID: toolSessionId,
        role: "assistant",
        time: {
          created: Date.now(),
        },
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
  return {
    type: "message.part.updated",
    properties: {
      ...(delta !== undefined ? { delta } : {}),
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

export function buildAssistantPartDelta(
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

export function buildToolPartUpdated(
  state: ToolPartEventState,
): Record<string, unknown> {
  return {
    type: "message.part.updated",
    properties: {
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
