import { z } from 'zod';

export const TOOL_EVENT_CLOUD_PROTOCOL = 'cloud' as const;
export type ToolEventCloudProtocol = typeof TOOL_EVENT_CLOUD_PROTOCOL;

/**
 * 为 cloud/skill provider event 增加显式 `protocol: "cloud"` discriminator，
 * 同时保持 payload 本体字段定义集中在各自事件 schema 中。
 */
export function withCloudProtocol<Schema extends z.ZodTypeAny>(schema: Schema) {
  return z
    .object({
      protocol: z.literal(TOOL_EVENT_CLOUD_PROTOCOL),
    })
    .passthrough()
    .pipe(
      z.preprocess((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return value;
        }

        const { protocol: _protocol, ...rest } = value as Record<string, unknown>;
        return rest;
      }, schema),
    )
    .transform((event) => ({
      protocol: TOOL_EVENT_CLOUD_PROTOCOL,
      ...(event as Record<string, unknown>),
    })) as unknown as z.ZodType<{ protocol: ToolEventCloudProtocol } & z.output<Schema>>;
}
