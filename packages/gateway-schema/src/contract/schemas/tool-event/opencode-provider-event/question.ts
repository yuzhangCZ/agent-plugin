import { z } from 'zod';
import { optionalLooseTrimmedString, requiredTrimmedString } from '../../shared.ts';

export const questionAskedOptionSchema = z
  .object({
    label: optionalLooseTrimmedString,
  })
  .transform((option) => (option.label ? { label: option.label } : undefined));
export type QuestionAskedOptionV1 = NonNullable<z.output<typeof questionAskedOptionSchema>>;

export const questionAskedItemSchema = z
  .object({
    question: requiredTrimmedString,
    header: optionalLooseTrimmedString,
    options: z
      .preprocess(
        (value) => (Array.isArray(value) ? value : undefined),
        z.array(questionAskedOptionSchema).optional(),
      )
      .transform((options) => {
        const normalized = options?.filter((option): option is QuestionAskedOptionV1 => option !== undefined);
        return normalized && normalized.length > 0 ? normalized : undefined;
      }),
  })
  .transform((item) => ({
    question: item.question,
    ...(item.header ? { header: item.header } : {}),
    ...(item.options ? { options: item.options } : {}),
  }));
export type QuestionAskedItemV1 = z.output<typeof questionAskedItemSchema>;

const questionAskedToolRefInputSchema = z
  .object({
    messageID: optionalLooseTrimmedString,
    callID: optionalLooseTrimmedString,
  })
  .transform((tool) => ({
    ...(tool.messageID ? { messageID: tool.messageID } : {}),
    ...(tool.callID ? { callID: tool.callID } : {}),
  }));

export const questionAskedToolRefSchema = z.object({
  messageID: requiredTrimmedString,
  callID: requiredTrimmedString,
});
export type QuestionAskedToolRefV1 = z.output<typeof questionAskedToolRefSchema>;

export const questionAskedEventSchema = z
  .object({
    type: z.literal('question.asked'),
    properties: z.object({
      sessionID: requiredTrimmedString,
      id: optionalLooseTrimmedString,
      messageID: optionalLooseTrimmedString,
      callID: optionalLooseTrimmedString,
      toolCallId: optionalLooseTrimmedString,
      questions: z
        .preprocess(
          (value) => (Array.isArray(value) ? value : undefined),
          z.array(questionAskedItemSchema).optional(),
        )
        .transform((questions) => (questions && questions.length > 0 ? questions : undefined)),
      tool: z
        .preprocess(
          (value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              return undefined;
            }

            return value;
          },
          questionAskedToolRefInputSchema.optional(),
        )
        .optional(),
    }),
  })
  .transform((event) => {
    const messageID = event.properties.tool?.messageID ?? event.properties.messageID;
    const callID = event.properties.tool?.callID ?? event.properties.callID ?? event.properties.toolCallId;

    return {
      type: 'question.asked' as const,
      properties: {
        sessionID: event.properties.sessionID,
        ...(event.properties.id ? { id: event.properties.id } : {}),
        ...(event.properties.questions ? { questions: event.properties.questions } : {}),
        ...(messageID && callID
          ? {
              tool: {
                messageID,
                callID,
              },
            }
          : {}),
      },
    };
  });
export type QuestionAskedEventV1 = z.output<typeof questionAskedEventSchema>;
