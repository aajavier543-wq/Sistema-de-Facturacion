import 'dotenv/config';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { initializeDeployment, runtimeEnvironment } from './deployment';
import { deploymentDiagnostic } from './deployment-errors';

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
main().catch((error: unknown) => {
  console.error('Deployment initialization failed', deploymentDiagnostic(error));
  process.exitCode = 1;
});
