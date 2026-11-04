import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException(
      result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  return result.data;
}
export const uuid = z.uuid();
export const money = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/,
    'Use un decimal positivo como texto, máximo 6 decimales',
  );
