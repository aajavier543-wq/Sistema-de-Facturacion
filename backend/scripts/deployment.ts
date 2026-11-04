import { Pool, escapeLiteral } from 'pg';
import { z } from 'zod';
import { migrate } from './migrate';
import { hashPassword } from '../src/security';

const configuration = z.object({
  MIGRATION_DATABASE_URL: z.url(),
  APP_DB_PASSWORD: z.string().min(16).max(256),
  BOOTSTRAP_EMAIL: z.email().transform((s) => s.toLowerCase()),
  BOOTSTRAP_PASSWORD: z.string().min(12).max(128),
  BOOTSTRAP_COMPANY: z.string().trim().min(1).max(200),
  BOOTSTRAP_RIF: z.string().regex(/^[VJEGP]-?\d{8}-?\d$/),
});

/** Run before HTTP starts. Existing roles, passwords and accounts are never reset. */
export async function initializeDeployment(input: NodeJS.ProcessEnv): Promise<string> {
  const config = configuration.parse(input);
  const owner = new Pool({ connectionString: config.MIGRATION_DATABASE_URL, max: 1 });
  try {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(758292)');
      const existing = await c.query("SELECT 1 FROM pg_roles WHERE rolname='erp_app'");
      if (!existing.rowCount) {
        await c.query(`CREATE ROLE erp_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
          PASSWORD ${escapeLiteral(config.APP_DB_PASSWORD)}`);
      }
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
    await migrate(config.MIGRATION_DATABASE_URL);

    const runtimeUrl = new URL(config.MIGRATION_DATABASE_URL);
    runtimeUrl.username = 'erp_app';
    runtimeUrl.password = config.APP_DB_PASSWORD;
    runtimeUrl.searchParams.delete('user');
    runtimeUrl.searchParams.delete('password');
    const runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 1 });
    try {
      const role = await runtime.query(`SELECT r.rolsuper,r.rolbypassrls,
        EXISTS(SELECT 1 FROM pg_class WHERE relname='products' AND relowner=r.oid) AS owns_tables
        FROM pg_roles r WHERE rolname=current_user`);
      if (role.rows[0]?.rolsuper || role.rows[0]?.rolbypassrls || role.rows[0]?.owns_tables)
        throw new Error('Unsafe runtime role');
      await runtime.query('SELECT id FROM products LIMIT 0');
    } finally {
      await runtime.end();
    }

    const c2 = await owner.connect();
    try {
      await c2.query('BEGIN');
      await c2.query('SELECT pg_advisory_xact_lock(758293)');
      const users = await c2.query('SELECT id,active FROM users WHERE email=$1', [
        config.BOOTSTRAP_EMAIL,
      ]);
      const tenants = await c2.query('SELECT id FROM tenants WHERE rif=$1', [config.BOOTSTRAP_RIF]);
      if (users.rowCount || tenants.rowCount) {
        const user = users.rows[0];
        const tenant = tenants.rows[0];
        const membership =
          user &&
          tenant &&
          user.active &&
          (
            await c2.query(
              "SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 AND role='admin'",
              [tenant.id, user.id],
            )
          ).rowCount;
        if (!membership)
          throw new Error('Bootstrap conflicts with existing identity; no permissions changed');
      } else {
        const user = await c2.query(
          'INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id',
          [config.BOOTSTRAP_EMAIL, await hashPassword(config.BOOTSTRAP_PASSWORD)],
        );
        const tenant = await c2.query('INSERT INTO tenants(name,rif) VALUES($1,$2) RETURNING id', [
          config.BOOTSTRAP_COMPANY,
          config.BOOTSTRAP_RIF,
        ]);
        await c2.query(
          "INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",
          [tenant.rows[0].id, user.rows[0].id],
        );
        await c2.query(
          "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
          [tenant.rows[0].id, user.rows[0].id],
        );
        await c2.query("INSERT INTO branches(tenant_id,name) VALUES($1,'Principal')", [
          tenant.rows[0].id,
        ]);
      }
      await c2.query('COMMIT');
    } catch (error) {
      await c2.query('ROLLBACK');
      throw error;
    } finally {
      c2.release();
    }
    return runtimeUrl.toString();
  } finally {
    await owner.end();
  }
}

export function runtimeEnvironment(
  input: NodeJS.ProcessEnv,
  databaseUrl: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input, DATABASE_URL: databaseUrl };
  for (const key of Object.keys(env)) {
    if (
      key === 'MIGRATION_DATABASE_URL' ||
      key === 'APP_DB_PASSWORD' ||
      key.startsWith('BOOTSTRAP_') ||
      key === 'RENDER_API_KEY' ||
      key === 'RENDER_API_TOKEN'
    )
      delete env[key];
  }
  return env;
}
