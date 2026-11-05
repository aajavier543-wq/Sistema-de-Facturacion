import { BadRequestException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { uuid } from './validation';
export const pricingSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    idempotencyKey: uuid,
    rate: z
      .string()
      .regex(/^(0|[1-9]\d{0,11})(\.\d{1,10})?$/)
      .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0),
    lines: z
      .array(
        z
          .object({
            lineId: uuid,
            profitPercent: z
              .string()
              .regex(/^(0|[1-9]\d{0,3})(\.\d{1,4})?$/)
              .refine((v) => Number.isFinite(Number(v)) && Number(v) <= 1000),
            expectedProductVersion: z.number().int().min(0),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.lines.map((l) => l.lineId)).size !== v.lines.length)
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: 'No repitas renglones en los márgenes',
      });
  });
export type PricingInput = z.infer<typeof pricingSchema>;
export function calculatePurchasePrice(
  line: { quantity: string; taxable_base: string; tax_rate: string },
  currency: 'VES' | 'USD',
  rate: string,
  profitPercent: string,
) {
  const quantity = new Decimal(line.quantity),
    net = new Decimal(line.taxable_base).div(quantity);
  const costUsd = currency === 'VES' ? net.div(rate) : net;
  const price = costUsd
    .mul(new Decimal(1).plus(new Decimal(profitPercent).div(100)))
    .toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  if (!price.isFinite() || price.lt(0) || price.gt('99999999999999.999999'))
    throw new BadRequestException('El precio calculado supera el límite admitido');
  const base = price.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const tax = base.mul(line.tax_rate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return {
    netCost: net.toFixed(6),
    costUsd: costUsd.toFixed(6),
    salePriceUsd: price.toFixed(6),
    saleTaxUsd: tax.toFixed(2),
    saleTotalUsd: base.plus(tax).toFixed(2),
    keepCurrentPrice: price.isZero(),
  };
}
