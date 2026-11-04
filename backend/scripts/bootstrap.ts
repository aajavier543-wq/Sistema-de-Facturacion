import 'dotenv/config';
import { Pool } from 'pg';
import { z } from 'zod';
import { hashPassword } from '../src/security';
async function main() {
  const input = z
    .object({
      MIGRATION_DATABASE_URL: z.string().min(1),
      BOOTSTRAP_EMAIL: z.email(),
      BOOTSTRAP_PASSWORD: z.string().min(12).max(128),
      BOOTSTRAP_COMPANY: z.string().min(1),
      BOOTSTRAP_RIF: z.string().regex(/^[VJEGP]-?\d{8}-?\d$/),
    })
    .parse(process.env);
  const pool = new Pool({ connectionString: input.MIGRATION_DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Existing users/companies are never silently changed or granted permissions.
    const user = await c.query(
      'INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id',
      [input.BOOTSTRAP_EMAIL.toLowerCase(), await hashPassword(input.BOOTSTRAP_PASSWORD)],
    );
    const tenant = await c.query('INSERT INTO tenants(name,rif) VALUES($1,$2) RETURNING id', [
      input.BOOTSTRAP_COMPANY,
      input.BOOTSTRAP_RIF,
    ]);
    await c.query(`INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')`, [
      tenant.rows[0].id,
      user.rows[0].id,
    ]);
    await c.query(`SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)`, [
      tenant.rows[0].id,
      user.rows[0].id,
    ]);
    await c.query(`INSERT INTO branches(tenant_id,name) VALUES($1,'Principal')`, [
      tenant.rows[0].id,
    ]);
    await c.query('COMMIT');
    console.log('Empresa, administrador y sucursal Principal creados.');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Bootstrap failed: validate inputs and ensure email/RIF do not already exist. No credentials were logged.',
  );
  process.exitCode = 1;
});
