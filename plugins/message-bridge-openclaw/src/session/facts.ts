import { randomUUID } from "node:crypto";

import type {
  MessageDoneFact,
  MessageStartFact,
  PermissionAskFact,
  ProviderError,
  QuestionAskFact,
  SessionErrorFact,
  TextDeltaFact,
  TextDoneFact,
  ToolUpdateFact,
} from "@agent-plugin/bridge-runtime-sdk";

export interface ToolUpdateFactInput {
  toolSessionId: string;
  messageId: string;
  partId: string;
  toolCallId: string;
  toolName: string;
  status: ToolUpdateFact["status"];
  title?: string;
  output?: unknown;
  error?: string;
  raw?: unknown;
}

export interface QuestionAskFactInput {
  toolSessionId: string;
  messageId: string;
  toolCallId: string;
  question: string;
  header?: string;
  options?: string[];
  context?: Record<string, unknown>;
  raw?: unknown;
}

export interface PermissionAskFactInput {
  toolSessionId: string;
  messageId: string;
  permissionId: string;
  toolCallId?: string;
  permissionType?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export function createToolSessionId(): string {
  return `ses_${randomUUID()}`;
}

export function buildMessageStartFact(input: {
  toolSessionId: string;
  messageId: string;
  raw?: unknown;
}): MessageStartFact {
  return {
    type: "message.start",
    toolSessionId: input.toolSessionId,
    messageId: input.messageId,
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildTextDeltaFact(input: {
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}): TextDeltaFact {
  return {
    type: "text.delta",
    toolSessionId: input.toolSessionId,
    messageId: input.messageId,
    partId: input.partId,
    content: input.content,
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildTextDoneFact(input: {
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}): TextDoneFact {
  return {
    type: "text.done",
    toolSessionId: input.toolSessionId,
    messageId: input.messageId,
    partId: input.partId,
    content: input.content,
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildMessageDoneFact(input: {
  toolSessionId: string;
  messageId: string;
  reason?: string;
  raw?: unknown;
}): MessageDoneFact {
  return {
    type: "message.done",
    toolSessionId: input.toolSessionId,
    messageId: input.messageId,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildToolUpdateFact(input: ToolUpdateFactInput): ToolUpdateFact {
  return {
    type: "tool.update",
    toolSessionId: input.toolSessionId,
    messageId: input.messageId,
    partId: input.partId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: input.status,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildQuestionAskFact(input: QuestionAskFactInput): QuestionAskFact {
  return {
    type: "question.ask",
    toolSessionId: input.toolSessionId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    question: input.question,
    ...(input.header !== undefined ? { header: input.header } : {}),
    ...(input.options !== undefined ? { options: input.options } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildPermissionAskFact(input: PermissionAskFactInput): PermissionAskFact {
  return {
    type: "permission.ask",
    toolSessionId: input.toolSessionId,
    messageId: input.messageId,
    permissionId: input.permissionId,
    ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
    ...(input.permissionType !== undefined ? { permissionType: input.permissionType } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function buildSessionErrorFact(input: {
  toolSessionId: string;
  error: ProviderError;
  raw?: unknown;
}): SessionErrorFact {
  return {
    type: "session.error",
    toolSessionId: input.toolSessionId,
    error: input.error,
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}
