import { z } from 'zod';

export const TOOL_EVENT_PAYLOAD_FAMILIES = ['opencode', 'skill'] as const;
export type ToolEventPayloadFamily = (typeof TOOL_EVENT_PAYLOAD_FAMILIES)[number];

/**
 * 为已存在的事件 schema 增加显式 family discriminator，
 * 保持 payload 本体字段不变，只把 `family` 作为协议层路由键补入输出。
 */
export function withToolEventFamily<Schema extends z.ZodTypeAny, Family extends ToolEventPayloadFamily>(
  family: Family,
  schema: Schema,
) {
  return z
    .object({
      family: z.literal(family),
    })
    .passthrough()
    .pipe(
      z.preprocess((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return value;
        }

        const { family: _family, ...rest } = value as Record<string, unknown>;
        return rest;
      }, schema),
    )
    .transform((event) => ({
      family,
      ...(event as Record<string, unknown>),
    })) as unknown as z.ZodType<{ family: Family } & z.output<Schema>>;
}
