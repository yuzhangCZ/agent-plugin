import { z } from 'zod';

import { requiredTrimmedString } from '../../shared.ts';
import { extParametersSchema } from '../../ext-parameters.ts';
import { withCloudProtocol } from '../shared-protocol.ts';

const skillPermissionAskEventPropertiesSchema = z
  .object({
    messageId: requiredTrimmedString.optional(),
    partId: requiredTrimmedString,
    permissionId: requiredTrimmedString,
    permType: requiredTrimmedString,
    title: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    extParameters: extParametersSchema.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (Object.prototype.hasOwnProperty.call(value, 'toolCallId')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolCallId'],
        message: 'toolCallId is not supported in cloud permission.ask properties',
      });
    }
  })
  .transform(({ messageId, partId, permissionId, permType, title, metadata, extParameters }) => ({
    ...(messageId === undefined ? {} : { messageId }),
    partId,
    permissionId,
    permType,
    title,
    ...(metadata === undefined ? {} : { metadata }),
    extParameters,
  }));

const skillPermissionAskEventBaseSchema = z.object({
  type: z.literal('permission.ask'),
  properties: skillPermissionAskEventPropertiesSchema,
});

const skillPermissionReplyEventBaseSchema = z.object({
  type: z.literal('permission.reply'),
  properties: z.object({
    permissionId: requiredTrimmedString,
    response: requiredTrimmedString,
    permType: requiredTrimmedString.optional(),
    messageId: requiredTrimmedString.optional(),
    partId: requiredTrimmedString.optional(),
    extParameters: extParametersSchema.optional(),
  }),
});

export const skillPermissionAskEventSchema = withCloudProtocol(skillPermissionAskEventBaseSchema);
export type SkillPermissionAskEvent = z.output<typeof skillPermissionAskEventSchema>;

export const skillPermissionReplyEventSchema = withCloudProtocol(skillPermissionReplyEventBaseSchema);
export type SkillPermissionReplyEvent = z.output<typeof skillPermissionReplyEventSchema>;
