import { z } from 'zod';

import type { ExtParameters } from '../types/ext-parameters.ts';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * gateway extParameters 只约束顶层容器，内部字段由业务双方自行约定。
 */
export const extParametersSchema: z.ZodType<ExtParameters> = z
  .union([
    z.null(),
    z.custom<Record<string, unknown>>(isPlainObject, {
      message: 'Expected plain object',
    }),
  ])
  .transform((extParameters) => extParameters as ExtParameters);
