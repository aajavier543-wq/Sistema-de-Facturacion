import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeDeployment } from '../scripts/deployment';
import { DeploymentFailure, deploymentDiagnostic } from '../scripts/deployment-errors';

test('configuración incompleta identifica variables sin intentar conectar PostgreSQL', async () => {
  await assert.rejects(initializeDeployment({}), (error: unknown) => {
    assert.ok(error instanceof DeploymentFailure);
    const diagnostic = deploymentDiagnostic(error);
    assert.equal(diagnostic.stage, 'configuration');
    assert.equal(diagnostic.code, 'INVALID_CONFIGURATION');
    assert.ok(diagnostic.fields?.includes('BOOTSTRAP_EMAIL'));
    assert.ok(diagnostic.fields?.includes('BOOTSTRAP_PASSWORD'));
    assert.ok(diagnostic.fields?.includes('MIGRATION_DATABASE_URL'));
    return true;
  });
});
test('las credenciales inválidas solo se reportan con código y etapa', () => {
  const secret = 'fixture-secret-not-a-real-password';
  const diagnostic = deploymentDiagnostic(
    new DeploymentFailure('runtime_connection', {
      code: '28P01',
      message: `Connection to postgresql://admin:${secret}@host/db failed`,
      detail: secret,
      query: `CREATE ROLE app PASSWORD '${secret}'`,
      stack: secret,
    }),
  );
  assert.equal(diagnostic.code, '28P01');
  assert.equal(diagnostic.stage, 'runtime_connection');
  assert.match(diagnostic.hint, /APP_DB_PASSWORD/);
  assert.ok(!JSON.stringify(diagnostic).includes(secret));
  assert.ok(!JSON.stringify(diagnostic).includes('postgresql://'));
});
test('permiso denegado distingue CREATEDB de CREATEROLE sin exponer errores del servidor', () => {
  const database = deploymentDiagnostic(
    new DeploymentFailure('select_database', { code: '42501' }),
  );
  const role = deploymentDiagnostic(new DeploymentFailure('provision_role', { code: '42501' }));
  assert.match(database.hint, /CREATEDB/);
  assert.match(role.hint, /CREATEROLE/);
});
test('errores inesperados no filtran mensaje, stack ni códigos arbitrarios', () => {
  const secret = 'fixture-private-string';
  const diagnostic = deploymentDiagnostic(
    new DeploymentFailure('migrations', { code: secret, message: secret, stack: secret }),
  );
  assert.equal(diagnostic.code, 'UNEXPECTED_ERROR');
  assert.ok(!JSON.stringify(diagnostic).includes(secret));
});
