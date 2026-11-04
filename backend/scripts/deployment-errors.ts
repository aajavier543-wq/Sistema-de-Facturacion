import { z } from 'zod';

export type DeploymentStage =
  | 'configuration'
  | 'select_database'
  | 'inspect_database'
  | 'provision_role'
  | 'migrations'
  | 'runtime_connection'
  | 'bootstrap';

const fields = [
  'MIGRATION_DATABASE_URL',
  'APP_DATABASE_NAME',
  'APP_DB_PASSWORD',
  'BOOTSTRAP_EMAIL',
  'BOOTSTRAP_PASSWORD',
  'BOOTSTRAP_COMPANY',
  'BOOTSTRAP_RIF',
];
const knownErrors: Record<string, string> = {
  'Application database must differ from the existing source database': 'SOURCE_EQUALS_TARGET',
  'Application database belongs to another owner': 'DATABASE_OWNER_MISMATCH',
  'Application database contains unrecognized data; initialization refused':
    'DATABASE_HAS_OTHER_DATA',
  'Unsafe runtime role': 'UNSAFE_RUNTIME_ROLE',
  'Bootstrap conflicts with existing identity; no permissions changed':
    'BOOTSTRAP_IDENTITY_CONFLICT',
};
const networkCodes = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Only allowlisted metadata is retained: never SQL, server messages, URLs or input values. */
export class DeploymentFailure extends Error {
  readonly code: string;
  readonly fields: string[];
  constructor(
    readonly stage: DeploymentStage,
    error: unknown,
  ) {
    super('Deployment initialization failed');
    if (error instanceof z.ZodError) {
      this.code = 'INVALID_CONFIGURATION';
      this.fields = [
        ...new Set(error.issues.map((i) => String(i.path[0])).filter((f) => fields.includes(f))),
      ];
    } else {
      const candidate = error as { code?: unknown; message?: unknown } | null;
      const code = typeof candidate?.code === 'string' ? candidate.code : '';
      this.code =
        /^[0-9A-Z]{5}$/.test(code) || networkCodes.has(code)
          ? code
          : (knownErrors[String(candidate?.message)] ?? 'UNEXPECTED_ERROR');
      this.fields = [];
    }
  }
}

export function deploymentDiagnostic(error: unknown) {
  const failure =
    error instanceof DeploymentFailure ? error : new DeploymentFailure('configuration', error);
  let hint: string;
  switch (failure.code) {
    case 'INVALID_CONFIGURATION':
      hint =
        'En Render > Environment, configura las variables indicadas. BOOTSTRAP_EMAIL debe ser un correo válido; BOOTSTRAP_PASSWORD debe tener 12–128 caracteres; APP_DB_PASSWORD al menos 16. sync:false no agrega variables nuevas al actualizar un Blueprint existente.';
      break;
    case '42501':
      hint =
        failure.stage === 'select_database'
          ? 'El propietario necesita CREATEDB para crear la base lógica separada; no uses la base de otra aplicación como sustituto.'
          : failure.stage === 'provision_role'
            ? 'El propietario necesita CREATEROLE para crear erp_app. No se atenderá HTTP con el propietario.'
            : 'El propietario no tiene permiso para esta etapa. Revisa los privilegios sobre la base destino.';
      break;
    case '28P01':
      hint =
        failure.stage === 'runtime_connection'
          ? 'La contraseña del rol erp_app existente no coincide con APP_DB_PASSWORD. No se ha cambiado ni restablecido.'
          : 'PostgreSQL rechazó las credenciales del propietario. Revisa la referencia fromDatabase de MIGRATION_DATABASE_URL.';
      break;
    case '3D000':
      hint = 'No existe la base destino. Revisa APP_DATABASE_NAME y los permisos CREATEDB.';
      break;
    case 'DATABASE_HAS_OTHER_DATA':
      hint =
        'El destino contiene datos no reconocidos. Selecciona una base dedicada vacía; no se eliminaron tablas.';
      break;
    case 'BOOTSTRAP_IDENTITY_CONFLICT':
      hint =
        'El correo o RIF ya existe con otra identidad o membresía. No se concedieron permisos ni se cambiaron contraseñas.';
      break;
    case 'UNSAFE_RUNTIME_ROLE':
      hint = 'erp_app debe ser un rol sin superuser, BYPASSRLS ni propiedad de las tablas.';
      break;
    default:
      hint = networkCodes.has(failure.code)
        ? 'Revisa conectividad, región y certificados de la conexión PostgreSQL. Mantén la verificación TLS habilitada.'
        : 'Revisa la etapa y el código indicados. El diagnóstico omite mensajes del servidor y SQL para proteger credenciales.';
  }
  return {
    stage: failure.stage,
    code: failure.code,
    ...(failure.fields.length ? { fields: failure.fields } : {}),
    hint,
  };
}
