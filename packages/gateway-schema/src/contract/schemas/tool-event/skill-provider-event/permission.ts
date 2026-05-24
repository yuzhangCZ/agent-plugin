import { z } from 'zod';

import { requiredTrimmedString } from '../../shared.ts';
import { withCloudProtocol } from '../shared-protocol.ts';

const skillPermissionAskEventBaseSchema = z.object({
  type: z.literal('permission.ask'),
  properties: z.object({
    messageId: requiredTrimmedString.optional(),
    partId: requiredTrimmedString,
    toolCallId: requiredTrimmedString,
    permissionId: requiredTrimmedString,
    permType: requiredTrimmedString.optional(),
    title: requiredTrimmedString.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).superRefine((value, ctx) => {
    if (value.toolCallId !== value.permissionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolCallId'],
        message: 'toolCallId must equal permissionId in cloud permission.ask properties',
      });
    }
  }),
});

const skillPermissionReplyEventBaseSchema = z.object({
  type: z.literal('permission.reply'),
  properties: z.object({
    permissionId: requiredTrimmedString,
    response: requiredTrimmedString,
    permType: requiredTrimmedString.optional(),
    messageId: requiredTrimmedString.optional(),
    partId: requiredTrimmedString.optional(),
  }),
});

export const skillPermissionAskEventSchema = withCloudProtocol(skillPermissionAskEventBaseSchema);
export type SkillPermissionAskEvent = z.output<typeof skillPermissionAskEventSchema>;

export const skillPermissionReplyEventSchema = withCloudProtocol(skillPermissionReplyEventBaseSchema);
export type SkillPermissionReplyEvent = z.output<typeof skillPermissionReplyEventSchema>;
