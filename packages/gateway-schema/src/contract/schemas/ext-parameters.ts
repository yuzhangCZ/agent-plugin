import { z } from 'zod';

import type { ExtParameters, UpstreamExtParameters } from '../types/ext-parameters.ts';
import { jsonValueSchema } from './tool-event/opencode-provider-event/json.ts';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && jsonValueSchema.safeParse(value).success;
}

/**
 * gateway 下行业务扩展透传容器。
 *
 * @remarks gateway-schema 不校验 `businessExtParam`，只校验 `platformExtParam` 的 JSON object 可序列化性；
 * `platformExtParam` 内部业务字段不在这里解释。
 */
export const downstreamExtParametersSchema: z.ZodType<ExtParameters> = z
  .custom<Record<string, unknown>>(isPlainObject, {
    message: 'Expected plain object',
  })
  .superRefine((extParameters, context) => {
    if (extParameters.platformExtParam !== undefined && !isJsonObject(extParameters.platformExtParam)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'platformExtParam must be a JSON object',
        path: ['platformExtParam'],
      });
    }
  })
  .transform((extParameters) => extParameters as ExtParameters);

/**
 * SDK 上行 event 扩展透传容器。
 *
 * @remarks 上行由 agent/provider 生成，SDK 只校验顶层 plain object，不绑定下行平台扩展字段结构。
 */
export const upstreamExtParametersSchema: z.ZodType<UpstreamExtParameters> = z
  .custom<Record<string, unknown>>(isPlainObject, {
    message: 'Expected plain object',
  })
  .transform((extParameters) => extParameters as UpstreamExtParameters);
