import { randomUUID } from "node:crypto";

import type {
  MessageDoneFact,
  MessageStartFact,
  PermissionAskFact,
  ProviderError,
  SessionErrorFact,
  ThinkingDeltaFact,
  ThinkingDoneFact,
  TextDeltaFact,
  TextDoneFact,
  ToolUpdateFact,
} from "@wecode/bridge-runtime-sdk";

export interface ToolUpdateFactInput {
  messageId: string;
  partId: string;
  toolCallId: string;
  toolName: string;
  status: ToolUpdateFact["status"];
  title?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  raw?: unknown;
}

export interface PermissionAskFactInput {
  messageId: string;
  partId: string;
  permissionId: string;
  permissionType?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

function stringifyToolPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined ? serialized : String(value);
  } catch {
    return String(value);
  }
}

export function createToolSessionId(): string {
  return `ses_${randomUUID()}`;
}

export function buildMessageStartFact(input: {
  messageId: string;
  raw?: unknown;
}): MessageStartFact {
  return {
    type: "message.start",
    messageId: input.messageId,
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildTextDeltaFact(input: {
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}): TextDeltaFact {
  return {
    type: "text.delta",
    messageId: input.messageId,
    partId: input.partId,
    content: input.content,
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildTextDoneFact(input: {
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}): TextDoneFact {
  return {
    type: "text.done",
    messageId: input.messageId,
    partId: input.partId,
    content: input.content,
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildThinkingDeltaFact(input: {
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}): ThinkingDeltaFact {
  return {
    type: "thinking.delta",
    messageId: input.messageId,
    partId: input.partId,
    content: input.content,
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildThinkingDoneFact(input: {
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}): ThinkingDoneFact {
  return {
    type: "thinking.done",
    messageId: input.messageId,
    partId: input.partId,
    content: input.content,
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildMessageDoneFact(input: {
  messageId: string;
  reason?: string;
  raw?: unknown;
}): MessageDoneFact {
  return {
    type: "message.done",
    messageId: input.messageId,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildToolUpdateFact(input: ToolUpdateFactInput): ToolUpdateFact {
  return {
    type: "tool.update",
    messageId: input.messageId,
    partId: input.partId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: input.status,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.input !== undefined ? { input: stringifyToolPayload(input.input) } : {}),
    ...(input.output !== undefined ? { output: stringifyToolPayload(input.output) } : {}),
    ...(input.error !== undefined ? { error: stringifyToolPayload(input.error) } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildPermissionAskFact(input: PermissionAskFactInput): PermissionAskFact {
  return {
    type: "permission.ask",
    messageId: input.messageId,
    partId: input.partId,
    permissionId: input.permissionId,
    ...(input.permissionType !== undefined ? { permissionType: input.permissionType } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildSessionErrorFact(input: {
  error: ProviderError;
  raw?: unknown;
}): SessionErrorFact {
  return {
    type: "session.error",
    error: input.error,
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}
