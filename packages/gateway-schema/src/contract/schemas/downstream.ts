import { z } from 'zod';
import {
  DOWNSTREAM_MESSAGE_TYPES,
  INVOKE_ACTIONS,
  PERMISSION_REPLY_RESPONSES,
  type InvokeAction,
} from '../literals/downstream.ts';
import {
  optionalLooseTrimmedString,
  optionalStrictTrimmedString,
  requiredTrimmedString,
} from './shared.ts';

const [INVOKE_MESSAGE_TYPE, STATUS_QUERY_MESSAGE_TYPE] = DOWNSTREAM_MESSAGE_TYPES;
const [CHAT_ACTION, CREATE_SESSION_ACTION, CLOSE_SESSION_ACTION, PERMISSION_REPLY_ACTION, ABORT_SESSION_ACTION, QUESTION_REPLY_ACTION] =
  INVOKE_ACTIONS;

export const statusQueryMessageSchema = z.object({
  type: z.literal(STATUS_QUERY_MESSAGE_TYPE),
});
export type StatusQueryMessage = z.output<typeof statusQueryMessageSchema>;

export const chatPayloadSchema = z
  .object({
    toolSessionId: requiredTrimmedString,
    text: requiredTrimmedString,
    assistantId: optionalStrictTrimmedString,
  })
  .transform((payload) => ({
    toolSessionId: payload.toolSessionId,
    text: payload.text,
    ...(payload.assistantId ? { assistantId: payload.assistantId } : {}),
  }));
export type ChatPayload = z.output<typeof chatPayloadSchema>;

export const createSessionPayloadSchema = z
  .object({
    title: optionalStrictTrimmedString,
    assistantId: optionalStrictTrimmedString,
  })
  .transform((payload) => ({
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.assistantId ? { assistantId: payload.assistantId } : {}),
  }));
export type CreateSessionPayload = z.output<typeof createSessionPayloadSchema>;

export const closeSessionPayloadSchema = z.object({
  toolSessionId: requiredTrimmedString,
});
export type CloseSessionPayload = z.output<typeof closeSessionPayloadSchema>;

export const abortSessionPayloadSchema = z.object({
  toolSessionId: requiredTrimmedString,
});
export type AbortSessionPayload = z.output<typeof abortSessionPayloadSchema>;

export const permissionReplyPayloadSchema = z.object({
  permissionId: requiredTrimmedString,
  toolSessionId: requiredTrimmedString,
  response: z.enum(PERMISSION_REPLY_RESPONSES),
});
export type PermissionReplyPayload = z.output<typeof permissionReplyPayloadSchema>;

export const questionReplyPayloadSchema = z
  .object({
    toolSessionId: requiredTrimmedString,
    answer: requiredTrimmedString,
    toolCallId: z.preprocess(
      (value) => {
        if (value === undefined) {
          return undefined;
        }

        return typeof value === 'string' ? value.trim() : undefined;
      },
      z.string().min(1).optional(),
    ),
  })
  .transform((payload) => ({
    toolSessionId: payload.toolSessionId,
    answer: payload.answer,
    ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
  }));
export type QuestionReplyPayload = z.output<typeof questionReplyPayloadSchema>;

export const chatInvokeSchema = z
  .object({
    type: z.literal(INVOKE_MESSAGE_TYPE),
    action: z.literal(CHAT_ACTION),
    welinkSessionId: optionalLooseTrimmedString,
    payload: chatPayloadSchema,
  })
  .transform((message) => ({
    type: INVOKE_MESSAGE_TYPE,
    action: CHAT_ACTION,
    payload: message.payload,
    ...(message.welinkSessionId ? { welinkSessionId: message.welinkSessionId } : {}),
  }));

export const createSessionInvokeSchema = z
  .object({
    type: z.literal(INVOKE_MESSAGE_TYPE),
    action: z.literal(CREATE_SESSION_ACTION),
    welinkSessionId: requiredTrimmedString,
    payload: createSessionPayloadSchema,
  })
  .transform((message) => ({
    type: INVOKE_MESSAGE_TYPE,
    action: CREATE_SESSION_ACTION,
    welinkSessionId: message.welinkSessionId,
    payload: message.payload,
  }));

export const closeSessionInvokeSchema = z
  .object({
    type: z.literal(INVOKE_MESSAGE_TYPE),
    action: z.literal(CLOSE_SESSION_ACTION),
    welinkSessionId: optionalLooseTrimmedString,
    payload: closeSessionPayloadSchema,
  })
  .transform((message) => ({
    type: INVOKE_MESSAGE_TYPE,
    action: CLOSE_SESSION_ACTION,
    payload: { toolSessionId: message.payload.toolSessionId },
    ...(message.welinkSessionId ? { welinkSessionId: message.welinkSessionId } : {}),
  }));

export const abortSessionInvokeSchema = z
  .object({
    type: z.literal(INVOKE_MESSAGE_TYPE),
    action: z.literal(ABORT_SESSION_ACTION),
    welinkSessionId: optionalLooseTrimmedString,
    payload: abortSessionPayloadSchema,
  })
  .transform((message) => ({
    type: INVOKE_MESSAGE_TYPE,
    action: ABORT_SESSION_ACTION,
    payload: { toolSessionId: message.payload.toolSessionId },
    ...(message.welinkSessionId ? { welinkSessionId: message.welinkSessionId } : {}),
  }));

export const permissionReplyInvokeSchema = z
  .object({
    type: z.literal(INVOKE_MESSAGE_TYPE),
    action: z.literal(PERMISSION_REPLY_ACTION),
    welinkSessionId: optionalLooseTrimmedString,
    payload: permissionReplyPayloadSchema,
  })
  .transform((message) => ({
    type: INVOKE_MESSAGE_TYPE,
    action: PERMISSION_REPLY_ACTION,
    payload: {
      permissionId: message.payload.permissionId,
      toolSessionId: message.payload.toolSessionId,
      response: message.payload.response,
    },
    ...(message.welinkSessionId ? { welinkSessionId: message.welinkSessionId } : {}),
  }));

export const questionReplyInvokeSchema = z
  .object({
    type: z.literal(INVOKE_MESSAGE_TYPE),
    action: z.literal(QUESTION_REPLY_ACTION),
    welinkSessionId: optionalLooseTrimmedString,
    payload: questionReplyPayloadSchema,
  })
  .transform((message) => ({
    type: INVOKE_MESSAGE_TYPE,
    action: QUESTION_REPLY_ACTION,
    payload: message.payload,
    ...(message.welinkSessionId ? { welinkSessionId: message.welinkSessionId } : {}),
  }));

export const invokeMessageSchema = z.union([
  chatInvokeSchema,
  createSessionInvokeSchema,
  closeSessionInvokeSchema,
  permissionReplyInvokeSchema,
  abortSessionInvokeSchema,
  questionReplyInvokeSchema,
]);
export type InvokeMessage = z.output<typeof invokeMessageSchema>;

export type InvokeMessageByAction = {
  [K in InvokeAction]: Extract<InvokeMessage, { action: K }>;
};

export type InvokePayloadByAction = {
  [K in InvokeAction]: InvokeMessageByAction[K]['payload'];
};

export interface ActionPayloadByName extends InvokePayloadByAction {
  status_query: Record<PropertyKey, never>;
}

export type InvokePayload = InvokePayloadByAction[InvokeAction];

export const downstreamMessageSchema = z.union([invokeMessageSchema, statusQueryMessageSchema]);
export const gatewayDownstreamBusinessRequestSchema = downstreamMessageSchema;
export type GatewayDownstreamBusinessRequest = z.output<typeof gatewayDownstreamBusinessRequestSchema>;

export const createSessionResultDataSchema = z
  .object({
    sessionId: optionalStrictTrimmedString,
  })
  .transform((data) => ({
    ...(data.sessionId ? { sessionId: data.sessionId } : {}),
  }));
export type CreateSessionResultData = z.output<typeof createSessionResultDataSchema>;

export const closeSessionResultDataSchema = z.object({
  sessionId: requiredTrimmedString,
  closed: z.literal(true),
});
export type CloseSessionResultData = z.output<typeof closeSessionResultDataSchema>;

export const permissionReplyResultDataSchema = z.object({
  permissionId: requiredTrimmedString,
  response: z.enum(PERMISSION_REPLY_RESPONSES),
  applied: z.literal(true),
});
export type PermissionReplyResultData = z.output<typeof permissionReplyResultDataSchema>;

export const statusQueryResultDataSchema = z.object({
  opencodeOnline: z.boolean(),
});
export type StatusQueryResultData = z.output<typeof statusQueryResultDataSchema>;

export const abortSessionResultDataSchema = z.object({
  sessionId: requiredTrimmedString,
  aborted: z.literal(true),
});
export type AbortSessionResultData = z.output<typeof abortSessionResultDataSchema>;

export const questionReplyResultDataSchema = z.object({
  requestId: requiredTrimmedString,
  replied: z.literal(true),
});
export type QuestionReplyResultData = z.output<typeof questionReplyResultDataSchema>;

export type ActionResultData =
  | CreateSessionResultData
  | CloseSessionResultData
  | PermissionReplyResultData
  | StatusQueryResultData
  | AbortSessionResultData
  | QuestionReplyResultData;

export interface ActionResultDataByAction {
  chat: void;
  create_session: CreateSessionResultData;
  close_session: CloseSessionResultData;
  permission_reply: PermissionReplyResultData;
  abort_session: AbortSessionResultData;
  question_reply: QuestionReplyResultData;
}

export interface ActionResultDataByName extends ActionResultDataByAction {
  status_query: StatusQueryResultData;
}
