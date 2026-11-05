import { z } from 'zod';
export const ocrOptionsSchema = z
  .object({
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    detailed: z.boolean().default(false),
    crop: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().min(0.05).max(1),
        height: z.number().min(0.05).max(1),
      })
      .strict()
      .refine((v) => v.x + v.width <= 1.000001 && v.y + v.height <= 1.000001)
      .nullable()
      .default(null),
  })
  .strict();
export type OcrOptions = z.infer<typeof ocrOptionsSchema>;
