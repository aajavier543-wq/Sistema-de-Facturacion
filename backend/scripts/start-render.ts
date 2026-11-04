import 'dotenv/config';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { initializeDeployment, runtimeEnvironment } from './deployment';

async function main() {
  const databaseUrl = await initializeDeployment(process.env);
  console.log('Database initialization complete. Starting HTTP with the restricted runtime role.');
  const child = spawn(process.execPath, [resolve(__dirname, '../src/main.js')], {
    env: runtimeEnvironment(process.env, databaseUrl),
    stdio: 'inherit',
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
  child.once('error', () => {
    console.error('HTTP process could not start');
    process.exitCode = 1;
  });
  child.once('exit', (code) => process.exit(code ?? 1));
}
main().catch(() => {
  console.error(
    'Deployment initialization failed. Check owner CREATEROLE permission, database connectivity, bootstrap inputs and existing erp_app credentials. No passwords were reset.',
  );
  process.exitCode = 1;
});
