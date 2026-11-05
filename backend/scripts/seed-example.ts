import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { seedInvoiceExample } from '../src/catalog-import';
async function main() {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? 'postgresql://invalid');
  if (!['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('This helper only modifies the local development database');
  const local = JSON.parse(await readFile('.local/admin.json', 'utf8')) as {
    email: string;
    rif: string;
  };
  const pool = new Pool({ connectionString: url.toString() });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const identity = (
      await c.query(
        `SELECT u.id AS user_id,t.id AS tenant_id FROM users u
   JOIN tenant_memberships m ON m.user_id=u.id AND m.role='admin' JOIN tenants t ON t.id=m.tenant_id
   WHERE u.email=$1 AND t.rif=$2`,
        [local.email, local.rif],
      )
    ).rows[0];
    if (!identity) throw new Error('Local bootstrap identity not found');
    await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [
      identity.tenant_id,
      identity.user_id,
    ]);
    const result = await seedInvoiceExample(c, {
      tenantId: identity.tenant_id,
      userId: identity.user_id,
      role: 'admin',
    });
    await c.query('COMMIT');
    console.log(
      'Example catalogue:',
      result,
      'No stock was received and sale prices remain pending.',
    );
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Local catalogue import failed; check migrations and the local bootstrap identity. No credentials logged.',
  );
  process.exitCode = 1;
});
