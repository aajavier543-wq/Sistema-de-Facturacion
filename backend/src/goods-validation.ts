import { z } from 'zod';
import { money, uuid } from './validation';
export const goodsSchema = z
  .object({
    kind: z.enum(['adjustment', 'purchase']),
    branchId: uuid,
    documentDate: z.iso.date(),
    description: z.string().trim().min(3).max(500),
    currency: z.enum(['USD', 'VES']),
    exchangeRate: z
      .string()
      .regex(/^(0|[1-9]\d{0,11})(\.\d{1,10})?$/)
      .refine((s) => Number(s) > 0),
    supplierId: uuid.nullable().default(null),
    invoiceNumber: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .transform((s) => s.toUpperCase())
      .nullable()
      .default(null),
    controlNumber: z.string().trim().min(1).max(80).nullable().default(null),
    paymentTerms: z.enum(['cash', 'credit']).nullable().default(null),
    dueDate: z.iso.date().nullable().default(null),
    lines: z
      .array(
        z
          .object({
            productId: uuid,
            direction: z.enum(['entry', 'exit']),
            quantity: money.refine((s) => Number(s) > 0),
            unitCost: money,
            discountPercent: money.refine((s) => Number(s) <= 100).default('0'),
            taxRate: z.enum(['0', '8', '16']).default('0'),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const goodsChecks = (data: z.infer<typeof goodsSchema>, ctx: z.RefinementCtx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  if (data.currency === 'VES' && Number(data.exchangeRate) !== 1)
    issue(['exchangeRate'], 'En bolívares la tasa debe ser 1');
  if (data.kind === 'purchase') {
    for (const field of ['supplierId', 'invoiceNumber', 'controlNumber', 'paymentTerms'] as const)
      if (!data[field]) issue([field], 'Campo requerido para una factura de compra');
    if (data.paymentTerms === 'credit' && !data.dueDate)
      issue(['dueDate'], 'Indica el vencimiento de la factura a crédito');
    if (data.lines.some((l) => l.direction !== 'entry'))
      issue(['lines'], 'Una factura de compra solo admite entradas');
  } else {
    if (
      data.supplierId ||
      data.invoiceNumber ||
      data.controlNumber ||
      data.paymentTerms ||
      data.dueDate
    )
      issue(['kind'], 'Los ajustes no llevan datos de factura o proveedor');
    if (data.lines.some((l) => Number(l.discountPercent) !== 0 || l.taxRate !== '0'))
      issue(['lines'], 'Los ajustes no aplican descuentos ni IVA');
  }
  if (data.dueDate && data.dueDate < data.documentDate)
    issue(['dueDate'], 'El vencimiento no puede ser anterior a la fecha del documento');
  const ids = new Set<string>();
  data.lines.forEach((l, i) => {
    if (ids.has(l.productId))
      issue(['lines', i, 'productId'], 'Un artículo solo puede aparecer una vez por documento');
    ids.add(l.productId);
  });
};
export type GoodsInput = z.infer<typeof goodsSchema>;
