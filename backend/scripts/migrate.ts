import 'dotenv/config';
import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
export async function migrate(connectionString: string) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(758291)`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const dir = path.resolve(__dirname, '../../migrations');
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount)
        continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(path.join(dir, name), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
        await client.query('COMMIT');
        console.log(`Applied ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(758291)');
    client.release();
    await pool.end();
  }
}
if (require.main === module) {
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
  migrate(process.env.MIGRATION_DATABASE_URL).catch(() => {
    console.error('Migration failed; verify owner credentials, schema and erp_app role');
    process.exitCode = 1;
  });
}
