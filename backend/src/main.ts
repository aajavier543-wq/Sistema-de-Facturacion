import 'dotenv/config';
import { createApplication } from './create-app';
async function main() {
  const app = await createApplication();
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
main().catch(() => {
  console.error('API startup failed; verify database role, connection and migrations');
  process.exitCode = 1;
});
