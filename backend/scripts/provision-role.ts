import 'dotenv/config';
import { Pool, escapeLiteral } from 'pg';
async function main() {
  if (
    !process.env.MIGRATION_DATABASE_URL ||
    !process.env.APP_DB_PASSWORD ||
    process.env.APP_DB_PASSWORD.length < 16
  )
    throw new Error(
      'Set owner MIGRATION_DATABASE_URL and APP_DB_PASSWORD (at least 16 characters) securely',
    );
  const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname='erp_app'");
    if (exists.rowCount) {
      console.log('erp_app already exists; credentials preserved.');
      return;
    }
    await pool.query(
      `CREATE ROLE erp_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${escapeLiteral(process.env.APP_DB_PASSWORD)}`,
    );
    console.log('Created non-owner runtime role erp_app.');
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Role provisioning failed. An owner with CREATEROLE is required; no credentials logged.',
  );
  process.exitCode = 1;
});
