import 'dotenv/config';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Pool, escapeLiteral } from 'pg';
import { initializeDeployment, runtimeEnvironment } from '../scripts/deployment';
import { verifyPassword } from '../src/security';

const suffix = randomBytes(6).toString('hex');
const database = `deploy_test_${suffix}`;
const isolatedDatabase = `nexo_test_${suffix}`;
const occupiedDatabase = `occupied_test_${suffix}`;
const ownerRole = `deploy_owner_${suffix}`;
let admin: Pool, owner: Pool;
let config: NodeJS.ProcessEnv;
before(async () => {
  if (!process.env.TEST_ADMIN_DATABASE_URL || !process.env.TEST_DATABASE_URL)
    throw new Error('Dedicated PostgreSQL test URLs are required');
  const control = new URL(process.env.TEST_ADMIN_DATABASE_URL);
  const app = new URL(process.env.TEST_DATABASE_URL);
  if (!control.pathname.endsWith('_test') || control.host !== app.host)
    throw new Error('Use dedicated matching test URLs');
  control.pathname = '/postgres';
  admin = new Pool({ connectionString: control.toString() });
  const password = randomBytes(24).toString('hex');
  await admin.query(
    `CREATE ROLE ${ownerRole} LOGIN CREATEDB CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`,
  );
  await admin.query(`CREATE DATABASE ${database} OWNER ${ownerRole}`);
  const ownerUrl = new URL(control);
  ownerUrl.username = ownerRole;
  ownerUrl.password = password;
  ownerUrl.pathname = '/' + database;
  config = {
    MIGRATION_DATABASE_URL: ownerUrl.toString(),
    APP_DB_PASSWORD: decodeURIComponent(app.password),
    BOOTSTRAP_EMAIL: 'deploy@example.test',
    BOOTSTRAP_PASSWORD: randomBytes(24).toString('hex'),
    BOOTSTRAP_COMPANY: 'Deployment test',
    BOOTSTRAP_RIF: 'J-00000000-3',
  };
  owner = new Pool({ connectionString: ownerUrl.toString() });
});
after(async () => {
  if (owner) await owner.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${isolatedDatabase} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${occupiedDatabase} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);
    await admin.end();
  }
});
test('reutiliza la instancia con una base lógica separada y conserva la aplicación original', async () => {
  await owner.query(
    'CREATE TABLE existing_app_records(id integer PRIMARY KEY, description text NOT NULL)',
  );
  await owner.query(
    "INSERT INTO existing_app_records VALUES(1,'Datos de la aplicación existente')",
  );
  const sourceSchema = await owner.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  );
  const first = await initializeDeployment({ ...config, APP_DATABASE_NAME: isolatedDatabase });
  const second = await initializeDeployment({ ...config, APP_DATABASE_NAME: isolatedDatabase });
  assert.ok(first === second, 'Restart must preserve the isolated database connection');
  const runtime = new Pool({ connectionString: first });
  try {
    assert.equal(
      (await runtime.query('SELECT current_database() AS db')).rows[0].db,
      isolatedDatabase,
    );
    assert.equal(
      (await runtime.query("SELECT to_regclass('public.existing_app_records') AS source_table"))
        .rows[0].source_table,
      null,
    );
  } finally {
    await runtime.end();
  }
  const afterSchema = await owner.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  );
  assert.deepEqual(afterSchema.rows, sourceSchema.rows);
  assert.equal(
    (await owner.query('SELECT description FROM existing_app_records WHERE id=1')).rows[0]
      .description,
    'Datos de la aplicación existente',
  );
});
test('rechaza una base destino ajena con datos sin crear tablas ni sobrescribirlos', async () => {
  await admin.query(`CREATE DATABASE ${occupiedDatabase} OWNER ${ownerRole}`);
  const url = new URL(config.MIGRATION_DATABASE_URL!);
  url.pathname = '/' + occupiedDatabase;
  const foreign = new Pool({ connectionString: url.toString() });
  try {
    await foreign.query('CREATE TABLE valuable_records(id integer PRIMARY KEY)');
    await foreign.query('INSERT INTO valuable_records VALUES(123)');
    await assert.rejects(
      initializeDeployment({ ...config, APP_DATABASE_NAME: occupiedDatabase }),
      /unrecognized data/,
    );
    assert.equal((await foreign.query('SELECT id FROM valuable_records')).rows[0].id, 123);
    assert.equal(
      (await foreign.query("SELECT to_regclass('public.schema_migrations') AS marker")).rows[0]
        .marker,
      null,
    );
  } finally {
    await foreign.end();
  }
});
test('bootstrap de despliegue funciona con propietario sin superuser y es repetible', async () => {
  const first = await initializeDeployment(config);
  const second = await initializeDeployment(config);
  assert.ok(first === second, 'Stable runtime credentials across restarts');
  const db = new Pool({ connectionString: first });
  try {
    const role = await db.query('SELECT current_user');
    assert.equal(role.rows[0].current_user, 'erp_app');
    assert.equal((await db.query('SELECT id FROM products')).rowCount, 0);
  } finally {
    await db.end();
  }
  const users = await owner.query('SELECT password_hash FROM users WHERE email=$1', [
    config.BOOTSTRAP_EMAIL,
  ]);
  assert.equal(users.rowCount, 1);
  assert.ok(await verifyPassword(config.BOOTSTRAP_PASSWORD!, users.rows[0].password_hash));
  assert.equal((await owner.query('SELECT id FROM tenants')).rowCount, 1);
  // Owner is subject to FORCE RLS when no context is set.
  assert.equal((await owner.query('SELECT id FROM branches')).rowCount, 0);
});
test('bootstrap no concede permisos sobre una identidad preexistente diferente', async () => {
  await assert.rejects(
    initializeDeployment({ ...config, BOOTSTRAP_RIF: 'J-00000000-4' }),
    /conflicts/,
  );
  assert.equal((await owner.query('SELECT id FROM tenants')).rowCount, 1);
});
test('el proceso HTTP no hereda credenciales de migración, bootstrap ni API de Render', () => {
  const env = runtimeEnvironment(
    { ...config, RENDER_API_KEY: 'test-only', PORT: '1234' },
    'postgresql://erp_app:example@localhost/test',
  );
  assert.equal(env.MIGRATION_DATABASE_URL, undefined);
  assert.equal(env.APP_DB_PASSWORD, undefined);
  assert.equal(env.BOOTSTRAP_PASSWORD, undefined);
  assert.equal(env.RENDER_API_KEY, undefined);
  assert.equal(env.PORT, '1234');
  assert.ok(new URL(env.DATABASE_URL!).username === 'erp_app');
});
test('entrypoint de Render inicia la interfaz y autentica después de un redespliegue', async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((r) => reservation.close(() => r()));
  const child = spawn(process.execPath, [resolve(__dirname, '../scripts/start-render.js')], {
    env: { ...process.env, ...config, PORT: String(port) },
    stdio: 'ignore',
  });
  const stopped = once(child, 'exit');
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null)
        throw new Error('Deployment entrypoint exited before becoming ready');
      try {
        ready = (await fetch(base + '/api/health/ready')).ok;
      } catch {}
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready, 'Render entrypoint must become ready');
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Nexo/);
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: config.BOOTSTRAP_EMAIL, password: config.BOOTSTRAP_PASSWORD }),
    });
    assert.equal(login.status, 201);
    assert.ok((await login.json()).accessToken);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await stopped;
  }
});
