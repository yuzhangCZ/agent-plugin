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
import type { ExtParameters, PlatformExtParam } from '../types/ext-parameters.ts';
import { jsonValueSchema } from './tool-event/opencode-provider-event/json.ts';

const [INVOKE_MESSAGE_TYPE, STATUS_QUERY_MESSAGE_TYPE] = DOWNSTREAM_MESSAGE_TYPES;
const [CHAT_ACTION, CREATE_SESSION_ACTION, CLOSE_SESSION_ACTION, PERMISSION_REPLY_ACTION, ABORT_SESSION_ACTION, QUESTION_REPLY_ACTION] =
  INVOKE_ACTIONS;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

export const statusQueryMessageSchema = z.object({
  type: z.literal(STATUS_QUERY_MESSAGE_TYPE),
});
export type StatusQueryMessage = z.output<typeof statusQueryMessageSchema>;

const requiredStringArrayItemSchema = z.string().transform((value) => value.trim()).pipe(z.string().min(1));

export const platformExtParamSchema: z.ZodType<PlatformExtParam> = z
  .object({
    businessSessionDomain: optionalStrictTrimmedString,
    businessSessionType: optionalStrictTrimmedString,
    businessSessionId: optionalStrictTrimmedString,
    allowedSlashCommands: z.array(requiredStringArrayItemSchema).optional(),
  })
  .passthrough()
  .transform((platformExtParam) => ({
    ...Object.fromEntries(
      Object.entries(platformExtParam).filter(
        ([key]) =>
          key !== 'businessSessionDomain'
          && key !== 'businessSessionType'
          && key !== 'businessSessionId'
          && key !== 'allowedSlashCommands',
      ),
    ),
    ...(platformExtParam.businessSessionDomain
      ? { businessSessionDomain: platformExtParam.businessSessionDomain }
      : {}),
    ...(platformExtParam.businessSessionType
      ? { businessSessionType: platformExtParam.businessSessionType }
      : {}),
    ...(platformExtParam.businessSessionId ? { businessSessionId: platformExtParam.businessSessionId } : {}),
    ...(platformExtParam.allowedSlashCommands !== undefined
      ? { allowedSlashCommands: platformExtParam.allowedSlashCommands }
      : {}),
  }));

export const extParametersSchema: z.ZodType<ExtParameters> = z
  .custom<Record<string, unknown>>(isPlainObject, {
    message: 'Expected plain object',
  })
  .pipe(
    z
      .object({
        businessExtParam: jsonValueSchema.optional(),
        platformExtParam: platformExtParamSchema.optional(),
      })
      .passthrough()
      .transform((extParameters) => ({
        ...Object.fromEntries(
          Object.entries(extParameters).filter(
            ([key]) => key !== 'businessExtParam' && key !== 'platformExtParam',
          ),
        ),
        ...(extParameters.businessExtParam !== undefined ? { businessExtParam: extParameters.businessExtParam } : {}),
        ...(extParameters.platformExtParam !== undefined ? { platformExtParam: extParameters.platformExtParam } : {}),
      })),
  );

export const chatPayloadSchema = z
  .object({
    toolSessionId: requiredTrimmedString,
    text: requiredTrimmedString,
    assistantId: optionalStrictTrimmedString,
    assistantAccount: optionalStrictTrimmedString,
    sendUserAccount: optionalStrictTrimmedString,
    imGroupId: optionalStrictTrimmedString,
    extParameters: extParametersSchema.optional(),
  })
  .transform((payload) => ({
    toolSessionId: payload.toolSessionId,
    text: payload.text,
    ...(payload.assistantId ? { assistantId: payload.assistantId } : {}),
    ...(payload.assistantAccount ? { assistantAccount: payload.assistantAccount } : {}),
    ...(payload.sendUserAccount ? { sendUserAccount: payload.sendUserAccount } : {}),
    ...(payload.imGroupId ? { imGroupId: payload.imGroupId } : {}),
    ...(payload.extParameters !== undefined ? { extParameters: payload.extParameters } : {}),
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
  response: z.enum(PERMISSION_REPLY_RESPONSES),
});
export type PermissionReplyPayload = z.output<typeof permissionReplyPayloadSchema>;

const questionAnswerSchema = z.array(z.string());
const questionAnswersSchema = z.array(questionAnswerSchema);

export const questionReplyPayloadSchema = z
  .object({
    questionId: optionalStrictTrimmedString,
    toolCallId: optionalStrictTrimmedString,
    answers: questionAnswersSchema.optional(),
    // legacy answer 只在 answers 缺失时作为兼容输入；JSON 数组字符串代表结构化 answers。
    answer: z.unknown().optional(),
  })
  .transform((payload, context) => {
    if (!payload.questionId && !payload.toolCallId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'question_reply requires questionId or toolCallId',
        path: ['questionId'],
      });
    }

    if (payload.answers !== undefined) {
      return {
        questionId: payload.questionId ?? payload.toolCallId!,
        answers: payload.answers,
      };
    }

    if (typeof payload.answer !== 'string') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'question_reply requires answers or legacy answer',
        path: ['answers'],
      });
      return z.NEVER;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.answer);
    } catch {
      return {
        questionId: payload.questionId ?? payload.toolCallId!,
        answers: [[payload.answer]],
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        questionId: payload.questionId ?? payload.toolCallId!,
        answers: [[payload.answer]],
      };
    }

    const structuredAnswer = questionAnswersSchema.safeParse(parsed);
    if (!structuredAnswer.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'question_reply serialized answer must be a string[][]',
        path: ['answer'],
      });
      return z.NEVER;
    }

    return {
      questionId: payload.questionId ?? payload.toolCallId!,
      answers: structuredAnswer.data,
    };
  });
export type QuestionReplyPayload = z.output<typeof questionReplyPayloadSchema>;

export const chatInvokeSchema = z
  .object({
    type: z.literal(INVOKE_MESSAGE_TYPE),
    action: z.literal(CHAT_ACTION),
    welinkSessionId: optionalLooseTrimmedString,
    suppressReply: z.boolean().optional(),
    payload: chatPayloadSchema,
  })
  .transform((message) => ({
    type: INVOKE_MESSAGE_TYPE,
    action: CHAT_ACTION,
    payload: message.payload,
    ...(message.welinkSessionId ? { welinkSessionId: message.welinkSessionId } : {}),
    ...(message.suppressReply !== undefined ? { suppressReply: message.suppressReply } : {}),
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

/**
 * downstream envelope 路由契约。
 * @remarks 这里只关心 message family 的 `type`，供 wire 入口做无副作用分流，不参与 payload 级校验。
 */
export const gatewayDownstreamEnvelopeSchema = z.object({
  type: z.enum(DOWNSTREAM_MESSAGE_TYPES),
});

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
