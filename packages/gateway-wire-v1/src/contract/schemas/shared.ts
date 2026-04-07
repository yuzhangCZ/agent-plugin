import { z } from 'zod';

export const requiredTrimmedString = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : undefined),
  z.string().min(1),
);

export const optionalLooseTrimmedString = z
  .preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return undefined;
      }

      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    },
    z.string().optional(),
  )
  .optional();

export const optionalStrictTrimmedString = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });
