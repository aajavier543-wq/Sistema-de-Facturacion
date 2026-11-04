import 'dotenv/config';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

export type Principal = { userId: string; tenantId: string; role: 'admin' | 'cashier' };

@Injectable()
export class Database implements OnModuleDestroy, OnModuleInit {
  readonly pool: Pool;
  constructor() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      options: '-c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000',
    });
    this.pool.on('error', (error) =>
      console.error('Idle PostgreSQL connection failed', {
        code: (error as { code?: string }).code,
      }),
    );
  }
  async onModuleInit() {
    const { rows } = await this.pool.query(`SELECT r.rolsuper, r.rolbypassrls,
      EXISTS(SELECT 1 FROM pg_class WHERE relname='products' AND relowner=r.oid) AS owns_tables
      FROM pg_roles r WHERE rolname=current_user`);
    const role = rows[0];
    if (!role || role.rolsuper || role.rolbypassrls || role.owns_tables)
      throw new Error('Unsafe database role: use the non-owner erp_app runtime role');
  }
  async transaction<T>(principal: Principal, run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)`,
        [principal.tenantId, principal.userId],
      );
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
