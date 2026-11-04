// Explicit development fixture, with a random password stored only in an ignored file.
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
const url = new URL(process.env.MIGRATION_DATABASE_URL ?? 'postgresql://invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname))
  throw new Error('Development bootstrap only accepts a local database');
mkdirSync('.local', { recursive: true, mode: 0o700 });
const file = '.local/admin.json';
if (existsSync(file)) {
  console.log('Local access file already exists; credentials preserved.');
  process.exit(0);
}
const credentials = {
  email: 'admin@local.test',
  password: randomBytes(24).toString('base64url'),
  company: 'Empresa de desarrollo',
  rif: 'J-00000000-1',
  note: 'Datos ficticios, solo para desarrollo. No usar en producción.',
};
writeFileSync(file, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const result = spawnSync(process.execPath, ['dist/scripts/bootstrap.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    BOOTSTRAP_EMAIL: credentials.email,
    BOOTSTRAP_PASSWORD: credentials.password,
    BOOTSTRAP_COMPANY: credentials.company,
    BOOTSTRAP_RIF: credentials.rif,
  },
});
if (result.status !== 0) {
  unlinkSync(file);
  process.exit(result.status ?? 1);
}
console.log('Acceso local guardado en backend/.local/admin.json (excluido de Git).');
