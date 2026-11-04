// Local development only. Creates random credentials in ignored .env; never logs them.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
const name = 'facturacion-dev-postgres';
const docker = (...args) => {
  const r = spawnSync('docker', ['--host=unix:///var/run/docker.sock', ...args], {
    encoding: 'utf8',
    env: process.env,
  });
  if (r.status !== 0) throw new Error(`Docker ${args[0]} failed: ${r.stderr || r.error?.message}`);
  return r.stdout.trim();
};
if (!existsSync('.env')) {
  const admin = randomBytes(24).toString('hex');
  const app = randomBytes(24).toString('hex');
  writeFileSync(
    '.env',
    `PORT=3000\nPOSTGRES_PASSWORD=${admin}\nAPP_DB_PASSWORD=${app}\nMIGRATION_DATABASE_URL=postgresql://postgres:${admin}@127.0.0.1:55432/erp\nDATABASE_URL=postgresql://erp_app:${app}@127.0.0.1:55432/erp\nTEST_ADMIN_DATABASE_URL=postgresql://postgres:${admin}@127.0.0.1:55432/erp_test\nTEST_DATABASE_URL=postgresql://erp_app:${app}@127.0.0.1:55432/erp_test\n`,
    { mode: 0o600, flag: 'wx' },
  );
}
const config = dotenv.parse(readFileSync('.env'));
if (!config.POSTGRES_PASSWORD || !config.APP_DB_PASSWORD)
  throw new Error('Existing .env is not a local DB configuration; preserved unchanged');
process.env.POSTGRES_PASSWORD = config.POSTGRES_PASSWORD;
const containers = docker('ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}');
if (containers) {
  const label = docker('inspect', '--format', '{{index .Config.Labels "app"}}', name);
  if (label !== 'facturacion-local') throw new Error('Container name conflict; no changes made');
  docker('start', name);
} else {
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'app=facturacion-local',
    '-p',
    '127.0.0.1:55432:5432',
    '-e',
    'POSTGRES_PASSWORD',
    '-e',
    'POSTGRES_DB=erp',
    '--mount',
    'type=volume,source=facturacion-dev-postgres-data,target=/var/lib/postgresql/data',
    'postgres:17-bookworm',
  );
}
for (let i = 0; i < 30; i++) {
  const result = spawnSync(
    'docker',
    ['--host=unix:///var/run/docker.sock', 'exec', name, 'pg_isready', '-U', 'postgres'],
    { encoding: 'utf8' },
  );
  if (result.status === 0) {
    console.log('PostgreSQL local disponible en el puerto 55432.');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
throw new Error('PostgreSQL did not become ready; inspect container logs');
