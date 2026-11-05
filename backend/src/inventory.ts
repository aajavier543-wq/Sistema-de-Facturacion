import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Database, Principal } from './database';
import { requireAdmin } from './auth';
export type Adjustment = {
  branchId: string;
  productId: string;
  delta: string;
  reason: string;
  idempotencyKey: string;
};
@Injectable()
export class InventoryService {
  constructor(private readonly db: Database) {}
  async adjust(principal: Principal, input: Adjustment) {
    requireAdmin(principal);
    return this.db.transaction(principal, async (client) => {
      // Serialize retries of the same request before reading/writing its result.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        principal.tenantId + ':' + input.idempotencyKey,
      ]);
      const existing = await client.query(
        `SELECT * FROM stock_movements WHERE idempotency_key=$1`,
        [input.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (
          prior.branch_id !== input.branchId ||
          prior.product_id !== input.productId ||
          !new Decimal(prior.delta).eq(input.delta) ||
          prior.reason !== input.reason
        )
          throw new ConflictException('La clave de idempotencia ya fue usada con otros datos');
        return { movement: prior, replayed: true };
      }
      const branch = await client.query('SELECT id FROM branches WHERE id=$1', [input.branchId]);
      const product = await client.query('SELECT id FROM products WHERE id=$1 AND active', [
        input.productId,
      ]);
      if (!branch.rowCount || !product.rowCount)
        throw new NotFoundException('Sucursal o producto no disponible');
      await client.query(
        `INSERT INTO stock_balances(tenant_id,branch_id,product_id)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [principal.tenantId, input.branchId, input.productId],
      );
      const balance = await client.query(
        `UPDATE stock_balances SET quantity=quantity+$1::numeric,version=version+1,
        average_cost_base=CASE WHEN $1::numeric>0 THEN NULL ELSE average_cost_base END
        WHERE branch_id=$2 AND product_id=$3 AND quantity+$1::numeric>=0 RETURNING quantity,version,average_cost_base`,
        [input.delta, input.branchId, input.productId],
      );
      if (!balance.rowCount) throw new ConflictException('Existencia insuficiente');
      const movement = await client.query(
        `INSERT INTO stock_movements
        (tenant_id,branch_id,product_id,delta,reason,actor_id,idempotency_key,unit_cost_base)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          principal.tenantId,
          input.branchId,
          input.productId,
          input.delta,
          input.reason,
          principal.userId,
          input.idempotencyKey,
          new Decimal(input.delta).isNegative() ? balance.rows[0].average_cost_base : null,
        ],
      );
      await client.query(
        `INSERT INTO audit_events(tenant_id,actor_id,action,entity_id,details)
        VALUES($1,$2,'stock.adjust',$3,$4)`,
        [principal.tenantId, principal.userId, movement.rows[0].id, JSON.stringify(input)],
      );
      return { movement: movement.rows[0], balance: balance.rows[0], replayed: false };
    });
  }
}
