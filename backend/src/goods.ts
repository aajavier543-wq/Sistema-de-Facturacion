import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { PoolClient } from 'pg';
import { Database, Principal } from './database';
import { requireAdmin } from './auth';
import { amount, calculateGoods } from './goods-calculation';
import { GoodsInput } from './goods-validation';

@Injectable()
export class GoodsService {
  constructor(private readonly db: Database) {}
  private async branch(c: PoolClient, id: string) {
    if (!(await c.query('SELECT id FROM branches WHERE id=$1', [id])).rowCount)
      throw new NotFoundException('Sucursal no disponible');
  }
  private async read(c: PoolClient, id: string) {
    const result = await c.query(
      `SELECT d.*,d.document_date::text AS document_date,d.due_date::text AS due_date,
     s.name AS supplier_name,s.rif AS supplier_rif FROM inventory_documents d
     LEFT JOIN suppliers s ON s.tenant_id=d.tenant_id AND s.id=d.supplier_id WHERE d.id=$1`,
      [id],
    );
    if (!result.rowCount) throw new NotFoundException('Documento no disponible');
    const lines = await c.query(
      'SELECT * FROM inventory_document_lines WHERE document_id=$1 ORDER BY position',
      [id],
    );
    return { ...result.rows[0], display_number: this.number(result.rows[0]), lines: lines.rows };
  }
  private number(d: { kind: string; number: string }) {
    return (d.kind === 'adjustment' ? 'AJ-' : 'FC-') + String(d.number).padStart(6, '0');
  }
  async get(p: Principal, id: string) {
    requireAdmin(p);
    return this.db.transaction(p, (c) => this.read(c, id));
  }
  async list(
    p: Principal,
    q: { branchId: string; kind: string; search: string; limit: number; offset: number },
  ) {
    requireAdmin(p);
    return this.db.transaction(p, async (c) => {
      await this.branch(c, q.branchId);
      const from = `FROM inventory_documents d LEFT JOIN suppliers s ON s.tenant_id=d.tenant_id AND s.id=d.supplier_id
       WHERE d.branch_id=$1 AND d.kind=$2 AND (strpos(lower(d.description),lower($3))>0
       OR strpos(coalesce(d.invoice_number,''),upper($3))>0 OR strpos(lower(coalesce(s.name,'')),lower($3))>0
       OR d.number::text=$3 OR (CASE WHEN d.kind='adjustment' THEN 'AJ-' ELSE 'FC-' END ||
       lpad(d.number::text,greatest(6,length(d.number::text)),'0'))=upper($3))`;
      const params = [q.branchId, q.kind, q.search];
      const count = await c.query(`SELECT count(*)::int AS total ${from}`, params);
      const rows = await c.query(
        `SELECT d.id,d.kind,d.number,d.status,d.document_date::text,d.description,d.currency,
       d.total,d.version,d.invoice_number,s.name AS supplier_name ${from} ORDER BY d.number DESC LIMIT $4 OFFSET $5`,
        [...params, q.limit, q.offset],
      );
      return {
        items: rows.rows.map((d) => ({ ...d, display_number: this.number(d) })),
        total: count.rows[0].total,
      };
    });
  }
  private async references(c: PoolClient, data: GoodsInput) {
    await this.branch(c, data.branchId);
    if (
      data.supplierId &&
      !(await c.query('SELECT id FROM suppliers WHERE id=$1', [data.supplierId])).rowCount
    )
      throw new NotFoundException('Proveedor no disponible');
    const products = await c.query(
      'SELECT id,sku,name FROM products WHERE id=ANY($1::uuid[]) AND active',
      [data.lines.map((l) => l.productId)],
    );
    if (products.rowCount !== data.lines.length)
      throw new BadRequestException('Hay artículos repetidos o no disponibles');
    const calculated = calculateGoods(data.kind, data.lines);
    // Validate converted costs before persisting; never let numeric overflow become a partial operation.
    for (const l of calculated.lines) {
      amount(new Decimal(l.taxableBase).mul(data.exchangeRate));
      if (new Decimal(l.taxableBase).mul(data.exchangeRate).div(l.quantity).gte('1e22'))
        throw new BadRequestException('El costo convertido supera el límite admitido');
    }
    return { calculated, products: new Map(products.rows.map((r) => [r.id, r])) };
  }
  async preview(p: Principal, data: GoodsInput) {
    requireAdmin(p);
    return this.db.transaction(p, async (c) => (await this.references(c, data)).calculated);
  }
  async save(
    p: Principal,
    data: GoodsInput,
    createKey: string | null,
    id?: string,
    expectedVersion?: number,
  ) {
    requireAdmin(p);
    const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return this.db.transaction(p, async (c) => {
      let before: any = null;
      if (id) {
        before = (await c.query('SELECT * FROM inventory_documents WHERE id=$1 FOR UPDATE', [id]))
          .rows[0];
        if (!before) throw new NotFoundException('Documento no disponible');
        if (before.status !== 'draft')
          throw new ConflictException('Un documento confirmado no se puede modificar');
        if (before.version !== expectedVersion)
          throw new ConflictException(
            'El documento fue modificado. Actualiza la consulta antes de guardar.',
          );
        if (before.branch_id !== data.branchId || before.kind !== data.kind)
          throw new ConflictException('No se puede cambiar la sucursal o tipo del documento');
      } else {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'goods:' + p.tenantId + ':' + createKey,
        ]);
        const existing = (
          await c.query('SELECT id,create_hash FROM inventory_documents WHERE create_key=$1', [
            createKey,
          ])
        ).rows[0];
        if (existing) {
          if (existing.create_hash !== hash)
            throw new ConflictException('La clave de creación ya fue usada con otros datos');
          return { ...(await this.read(c, existing.id)), replayed: true };
        }
      }
      const { calculated, products } = await this.references(c, data);
      const values = [
        data.documentDate,
        data.description,
        data.currency,
        data.exchangeRate,
        data.supplierId,
        data.invoiceNumber,
        data.controlNumber,
        data.paymentTerms,
        data.dueDate,
        calculated.subtotal,
        calculated.discountTotal,
        calculated.taxTotal,
        calculated.total,
      ];
      let documentId = id;
      if (id) {
        await c.query(
          `UPDATE inventory_documents SET document_date=$2,description=$3,currency=$4,exchange_rate=$5,
         supplier_id=$6,invoice_number=$7,control_number=$8,payment_terms=$9,due_date=$10,
         subtotal=$11,discount_total=$12,tax_total=$13,total=$14,version=version+1 WHERE id=$1`,
          [id, ...values],
        );
        await c.query('DELETE FROM inventory_document_lines WHERE document_id=$1', [id]);
      } else {
        const counter = await c.query(
          `INSERT INTO document_counters(tenant_id,kind,last_number) VALUES($1,$2,1)
         ON CONFLICT(tenant_id,kind) DO UPDATE SET last_number=document_counters.last_number+1 RETURNING last_number`,
          [p.tenantId, data.kind],
        );
        const doc = await c.query(
          `INSERT INTO inventory_documents(tenant_id,branch_id,kind,number,document_date,
         description,currency,exchange_rate,supplier_id,invoice_number,control_number,payment_terms,due_date,
         subtotal,discount_total,tax_total,total,create_key,create_hash,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
          [
            p.tenantId,
            data.branchId,
            data.kind,
            counter.rows[0].last_number,
            ...values,
            createKey,
            hash,
            p.userId,
          ],
        );
        documentId = doc.rows[0].id;
      }
      for (let i = 0; i < calculated.lines.length; i++) {
        const l = calculated.lines[i]!;
        const product = products.get(l.productId)!;
        await c.query(
          `INSERT INTO inventory_document_lines(tenant_id,document_id,branch_id,position,product_id,sku,name,
         direction,quantity,unit_cost,discount_percent,tax_rate,gross,discount_amount,taxable_base,tax_amount,total)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            p.tenantId,
            documentId,
            data.branchId,
            i + 1,
            l.productId,
            product.sku,
            product.name,
            l.direction,
            l.quantity,
            l.unitCost,
            l.discountPercent,
            l.taxRate,
            l.gross,
            l.discountAmount,
            l.taxableBase,
            l.taxAmount,
            l.total,
          ],
        );
      }
      await c.query(
        `INSERT INTO audit_events(tenant_id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)`,
        [
          p.tenantId,
          p.userId,
          id ? 'goods.draft.update' : 'goods.draft.create',
          documentId,
          JSON.stringify({ kind: data.kind, previousVersion: before?.version ?? null }),
        ],
      );
      return { ...(await this.read(c, documentId!)), replayed: false };
    });
  }
  async confirm(p: Principal, id: string, expectedVersion: number) {
    requireAdmin(p);
    return this.db.transaction(p, async (c) => {
      const d = (await c.query('SELECT * FROM inventory_documents WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!d) throw new NotFoundException('Documento no disponible');
      if (d.status === 'confirmed') return { ...(await this.read(c, id)), replayed: true };
      if (d.version !== expectedVersion)
        throw new ConflictException(
          'El documento cambió. Vuelve a consultarlo antes de confirmar.',
        );
      const lines = (
        await c.query(
          'SELECT * FROM inventory_document_lines WHERE document_id=$1 ORDER BY product_id',
          [id],
        )
      ).rows;
      if (!lines.length) throw new ConflictException('No hay renglones para confirmar');
      const products = await c.query(
        'SELECT id FROM products WHERE id=ANY($1::uuid[]) AND active',
        [lines.map((l) => l.product_id)],
      );
      if (products.rowCount !== lines.length)
        throw new ConflictException('Un artículo ya no está disponible. Revisa el borrador.');
      // All documents lock balances in the same order, including zero balances for new products.
      for (const l of lines)
        await c.query(
          `INSERT INTO stock_balances(tenant_id,branch_id,product_id)
       VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [p.tenantId, d.branch_id, l.product_id],
        );
      const balances = (
        await c.query(
          `SELECT * FROM stock_balances WHERE branch_id=$1 AND product_id=ANY($2::uuid[])
       ORDER BY product_id FOR UPDATE`,
          [d.branch_id, lines.map((l) => l.product_id)],
        )
      ).rows;
      let valuation: Decimal | null = new Decimal(0);
      for (const l of lines) {
        const balance = balances.find((b) => b.product_id === l.product_id)!;
        const qty = new Decimal(l.quantity);
        const previous = new Decimal(balance.quantity);
        const delta = l.direction === 'entry' ? qty : qty.negated();
        const next = previous.plus(delta);
        if (next.isNegative()) throw new ConflictException('Existencia insuficiente para ' + l.sku);
        if (next.gt('99999999999999.999999'))
          throw new BadRequestException('La existencia supera el límite admitido');
        let avg =
          balance.average_cost_base === null ? null : new Decimal(balance.average_cost_base);
        let applied: Decimal | null;
        let lineValue: Decimal | null;
        if (l.direction === 'entry') {
          const entryValue = new Decimal(l.taxable_base).mul(d.exchange_rate);
          applied = entryValue.div(qty).toDecimalPlaces(8);
          lineValue = entryValue;
          avg = previous.isZero()
            ? applied
            : avg === null
              ? null
              : previous.mul(avg).plus(entryValue).div(next).toDecimalPlaces(8);
        } else {
          applied = avg;
          lineValue = avg === null ? null : qty.mul(avg).negated();
        }
        if (lineValue === null) valuation = null;
        else if (valuation !== null) valuation = valuation.plus(lineValue);
        await c.query(
          `UPDATE stock_balances SET quantity=$3,average_cost_base=$4,version=version+1
         WHERE branch_id=$1 AND product_id=$2`,
          [d.branch_id, l.product_id, next.toFixed(6), avg?.toFixed(8) ?? null],
        );
        await c.query('UPDATE inventory_document_lines SET applied_cost_base=$2 WHERE id=$1', [
          l.id,
          applied?.toFixed(8) ?? null,
        ]);
        await c.query(
          `INSERT INTO stock_movements(tenant_id,branch_id,product_id,delta,reason,actor_id,idempotency_key,
         document_id,document_line_id,unit_cost_base) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            p.tenantId,
            d.branch_id,
            l.product_id,
            delta.toFixed(6),
            this.number(d) + ' · ' + d.description,
            p.userId,
            l.id,
            id,
            l.id,
            applied?.toFixed(8) ?? null,
          ],
        );
      }
      await c.query(
        `UPDATE inventory_documents SET status='confirmed',confirmed_by=$2,confirmed_at=now(),
       inventory_value_base=$3,version=version+1 WHERE id=$1`,
        [id, p.userId, valuation === null ? null : amount(valuation)],
      );
      await c.query(
        `INSERT INTO audit_events(tenant_id,actor_id,action,entity_id,details)
       VALUES($1,$2,'goods.confirm',$3,$4)`,
        [
          p.tenantId,
          p.userId,
          id,
          JSON.stringify({ kind: d.kind, number: this.number(d), lines: lines.length }),
        ],
      );
      return { ...(await this.read(c, id)), replayed: false };
    });
  }
}
