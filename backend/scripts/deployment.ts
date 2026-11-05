import { Pool, escapeLiteral, escapeIdentifier } from 'pg';
import { z } from 'zod';
import { migrate } from './migrate';
import { hashPassword } from '../src/security';
import { seedInvoiceExample } from '../src/catalog-import';
import { DeploymentFailure, DeploymentStage } from './deployment-errors';

const configuration = z.object({
  SEED_NICOPHARMA_EXAMPLE: z.enum(['true', 'false']).default('true'),
  MIGRATION_DATABASE_URL: z.url(),
  APP_DATABASE_NAME: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/)
    .optional(),
  APP_DB_PASSWORD: z.string().min(16).max(256),
  BOOTSTRAP_EMAIL: z.email().transform((s) => s.toLowerCase()),
  BOOTSTRAP_PASSWORD: z.string().min(12).max(128),
  BOOTSTRAP_COMPANY: z.string().trim().min(1).max(200),
  BOOTSTRAP_RIF: z.string().regex(/^[VJEGP]-?\d{8}-?\d$/),
});

/** Run before HTTP starts. Existing roles, passwords and accounts are never reset. */
export async function initializeDeployment(input: NodeJS.ProcessEnv): Promise<string> {
  let stage: DeploymentStage = 'configuration';
  const progress = (next: DeploymentStage) => {
    stage = next;
    console.log(`[deployment] ${next}`);
  };
  try {
    progress('configuration');
    const config = configuration.parse(input);
    return await initializeConfiguredDeployment(config, progress);
  } catch (error) {
    throw new DeploymentFailure(stage, error);
  }
}

async function initializeConfiguredDeployment(
  config: z.infer<typeof configuration>,
  progress: (stage: DeploymentStage) => void,
): Promise<string> {
  progress('select_database');
  const migrationUrl = config.APP_DATABASE_NAME
    ? await selectApplicationDatabase(config.MIGRATION_DATABASE_URL, config.APP_DATABASE_NAME)
    : config.MIGRATION_DATABASE_URL;
  const owner = new Pool({
    connectionString: migrationUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  try {
    progress('inspect_database');
    if (config.APP_DATABASE_NAME) await verifyApplicationDatabase(owner);
    progress('provision_role');
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
    progress('migrations');
    await migrate(migrationUrl);

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'erp_app';
    runtimeUrl.password = config.APP_DB_PASSWORD;
    runtimeUrl.searchParams.delete('user');
    runtimeUrl.searchParams.delete('password');
    progress('runtime_connection');
    const runtime = new Pool({
      connectionString: runtimeUrl.toString(),
      max: 1,
      connectionTimeoutMillis: 10000,
    });
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

    progress('bootstrap');
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
      if (config.SEED_NICOPHARMA_EXAMPLE === 'true') {
        const targetUser = (
          await c2.query('SELECT id FROM users WHERE email=$1', [config.BOOTSTRAP_EMAIL])
        ).rows[0];
        const targetTenant = (
          await c2.query('SELECT id FROM tenants WHERE rif=$1', [config.BOOTSTRAP_RIF])
        ).rows[0];
        await c2.query(
          "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
          [targetTenant.id, targetUser.id],
        );
        const loaded = await seedInvoiceExample(c2, {
          tenantId: targetTenant.id,
          userId: targetUser.id,
          role: 'admin',
        });
        console.log(
          'Example catalogue prepared:',
          loaded.created,
          'created;',
          loaded.existing,
          'already present. No stock was received.',
        );
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

/** Render supports additional logical databases on an existing Postgres instance.
 * Only database-level metadata is changed on the source; its tables are untouched.
 */
async function selectApplicationDatabase(source: string, name: string): Promise<string> {
  const url = new URL(source);
  if (decodeURIComponent(url.pathname.slice(1)) === name)
    throw new Error('Application database must differ from the existing source database');
  const pool = new Pool({ connectionString: source, max: 1, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(758294)');
    const found = await client.query(
      `SELECT pg_get_userbyid(datdba)=current_user AS owned
      FROM pg_database WHERE datname=$1`,
      [name],
    );
    if (found.rowCount) {
      if (!found.rows[0].owned) throw new Error('Application database belongs to another owner');
    } else {
      // CREATE DATABASE cannot run inside a transaction; serialize via a session lock.
      await client.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(758294)');
    } finally {
      client.release();
      await pool.end();
    }
  }
  url.pathname = '/' + name;
  url.searchParams.delete('database');
  url.searchParams.delete('dbname');
  return url.toString();
}

async function verifyApplicationDatabase(owner: Pool): Promise<void> {
  const tables = await owner.query(`SELECT schemaname,tablename FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_%'`);
  if (!tables.rowCount) return;
  const marker = await owner.query("SELECT to_regclass('public.schema_migrations') AS name");
  if (marker.rows[0].name) {
    const migrations = await owner.query('SELECT name FROM public.schema_migrations');
    // Recover a previously interrupted initial migration, which leaves an empty marker.
    if (tables.rowCount === 1 && !migrations.rowCount) return;
    const product = await owner.query(`SELECT relrowsecurity AND relforcerowsecurity AS protected
      FROM pg_class WHERE oid=to_regclass('public.products')`);
    if (migrations.rows.some((m) => m.name === '001_foundation.sql') && product.rows[0]?.protected)
      return;
  }
  throw new Error('Application database contains unrecognized data; initialization refused');
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
