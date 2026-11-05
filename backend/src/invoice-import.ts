import { BadRequestException, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { Database, Principal } from './database';
import { requireAdmin } from './auth';
import { resolveImportProduct, normalizeProductName } from './catalog-import';
import { GoodsService } from './goods';
import { goodsChecks, goodsSchema } from './goods-validation';
import { money, parse, uuid } from './validation';
import { calculateGoods } from './goods-calculation';

export const invoiceReviewSchema = z
  .object({
    branchId: uuid,
    idempotencyKey: uuid,
    reviewed: z.literal(true),
    sourceKind: z.enum(['image', 'example']),
    purchaseDocumentType: z.enum(['invoice', 'delivery_note']).default('invoice'),
    imageHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    rawText: z.string().max(50000).default(''),
    supplierName: z.string().trim().min(2).max(200),
    supplierRif: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase().replace(/[-\s]/g, ''))
      .pipe(z.string().regex(/^[VJEGP]\d{9}$/, 'Verifica el RIF del proveedor')),
    invoiceNumber: z.string().trim().min(1).max(80),
    controlNumber: z.string().trim().min(1).max(80).nullable().default(null),
    documentDate: z.iso.date(),
    currency: z.enum(['USD', 'VES']),
    exchangeRate: z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,10})?$/),
    declaredTotal: money,
    paymentTerms: z.enum(['cash', 'credit']).default('cash'),
    dueDate: z.iso.date().nullable().default(null),
    lines: z
      .array(
        z
          .object({
            name: z.string().trim().min(3).max(200),
            quantity: money.refine((s) => Number(s) > 0),
            unitCost: money,
            discountPercent: money.refine((s) => Number(s) <= 100).default('0'),
            taxRate: z.enum(['0', '8', '16']),
            existingSku: z.string().trim().max(64).nullable().default(null),
            sourceKey: z.string().max(100).nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.purchaseDocumentType === 'invoice' && !v.controlNumber)
      ctx.addIssue({
        code: 'custom',
        path: ['controlNumber'],
        message: 'Indica el control de la factura',
      });
    if (v.purchaseDocumentType === 'delivery_note' && v.controlNumber !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['controlNumber'],
        message: 'Una nota de entrega no lleva control fiscal',
      });
    if (v.sourceKind === 'image' && !v.imageHash)
      ctx.addIssue({
        code: 'custom',
        path: ['imageHash'],
        message: 'Falta la referencia de la imagen leída',
      });
  });
export type InvoiceReview = z.infer<typeof invoiceReviewSchema>;

@Injectable()
export class InvoiceImporter {
  constructor(
    private readonly db: Database,
    private readonly goods: GoodsService,
  ) {}
  async apply(p: Principal, input: InvoiceReview) {
    requireAdmin(p);
    const provisional = calculateGoods(
      'purchase',
      input.lines.map((l) => ({ ...l, direction: 'entry' as const, productId: 'review' })),
    );
    if (!new Decimal(provisional.total).eq(input.declaredTotal))
      throw new BadRequestException(
        `Los renglones suman ${new Decimal(provisional.total).toFixed(2)}, pero el total declarado es ${new Decimal(input.declaredTotal).toFixed(2)}. Corrige la lectura antes de importar.`,
      );
    return this.db.transaction(p, async (c) => {
      if (!(await c.query('SELECT id FROM branches WHERE id=$1', [input.branchId])).rowCount)
        throw new BadRequestException('Sucursal no disponible');
      // A stable order prevents name-lock deadlocks between concurrent imports.
      const resolved = new Map<number, { product: { id: string }; created: boolean }>();
      let createdProducts = 0;
      const ordered = input.lines
        .map((l, index) => ({ l, index }))
        .sort((a, b) =>
          normalizeProductName(a.l.name).localeCompare(normalizeProductName(b.l.name), 'en'),
        );
      for (const { l, index } of ordered) {
        let productId: string | null = null;
        if (l.existingSku) {
          const found = (
            await c.query('SELECT id FROM products WHERE sku=$1 AND active', [l.existingSku])
          ).rows[0];
          if (!found)
            throw new BadRequestException(
              'No existe el código de artículo seleccionado: ' + l.existingSku,
            );
          productId = found.id;
        }
        const product = await resolveImportProduct(c, p, {
          name: l.name,
          productId,
          sourceKey: input.sourceKind === 'example' ? l.sourceKey : null,
          taxRate: l.taxRate,
        });
        resolved.set(index, product);
        if (product.created) createdProducts++;
      }
      const rif = input.supplierRif;
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'supplier:' + p.tenantId + ':' + rif,
      ]);
      let supplier = (await c.query('SELECT id FROM suppliers WHERE rif=$1', [rif])).rows[0];
      if (!supplier) {
        supplier = (
          await c.query('INSERT INTO suppliers(tenant_id,rif,name) VALUES($1,$2,$3) RETURNING id', [
            p.tenantId,
            rif,
            input.supplierName,
          ])
        ).rows[0];
        await c.query(
          `INSERT INTO audit_events(tenant_id,actor_id,action,entity_id,details)
     VALUES($1,$2,'supplier.import',$3,$4)`,
          [p.tenantId, p.userId, supplier.id, JSON.stringify({ source: input.sourceKind })],
        );
      }
      const data = parse(goodsSchema.superRefine(goodsChecks), {
        kind: 'purchase',
        purchaseDocumentType: input.purchaseDocumentType,
        branchId: input.branchId,
        documentDate: input.documentDate,
        description:
          (input.purchaseDocumentType === 'delivery_note'
            ? 'Nota de entrega importada '
            : 'Factura importada ') + input.invoiceNumber,
        currency: input.currency,
        exchangeRate: input.exchangeRate,
        supplierId: supplier.id,
        invoiceNumber: input.invoiceNumber,
        controlNumber: input.controlNumber,
        paymentTerms: input.paymentTerms,
        dueDate: input.dueDate,
        lines: input.lines.map((l, i) => ({
          productId: resolved.get(i)!.product.id,
          direction: 'entry',
          quantity: l.quantity,
          unitCost: l.unitCost,
          discountPercent: l.discountPercent,
          taxRate: l.taxRate,
        })),
      });
      const document = await this.goods.saveWithClient(c, p, data, input.idempotencyKey);
      if (!document.replayed) {
        await c.query(
          `UPDATE inventory_documents SET source_kind=$2,source_image_hash=$3,source_ocr_text=$4 WHERE id=$1`,
          [document.id, input.sourceKind, input.imageHash, input.rawText || null],
        );
        await c.query(
          `INSERT INTO audit_events(tenant_id,actor_id,action,entity_id,details)
     VALUES($1,$2,'invoice.image.import',$3,$4)`,
          [
            p.tenantId,
            p.userId,
            document.id,
            JSON.stringify({
              source: input.sourceKind,
              imageHash: input.imageHash,
              createdProducts,
            }),
          ],
        );
      }
      return {
        ...document,
        source_kind: document.replayed ? document.source_kind : input.sourceKind,
        source_image_hash: document.replayed ? document.source_image_hash : input.imageHash,
        source_ocr_text: document.replayed ? document.source_ocr_text : input.rawText || null,
        createdProducts,
        linkedProducts: input.lines.length - createdProducts,
      };
    });
  }
}
