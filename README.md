# Nexo · Sistema de facturación

Base funcional de un sistema administrativo y POS para Venezuela, con interfaz modular 0.2.
Backend NestJS/TypeScript, PostgreSQL 17 con RLS e interfaz React. Node.js 24 recomendado.

## Qué funciona

- Login con contraseñas scrypt, sesiones de 8 horas revocables y límite de intentos por cuenta.
- Empresas aisladas mediante RLS, permisos por sucursal y roles administrador/cajero.
- Creación y búsqueda de productos por nombre, SKU y código de barras.
- Existencias por sucursal, ajustes auditados, idempotencia y rechazo de saldos negativos.
- Vista previa con IVA 16 %, 8 % o exento y principal repartido entre tramos elegibles/no elegibles para IGTF al 3 %.
- Interfaz con búsqueda F2 y lectura de código + Enter cuando hay un solo resultado.
- Panel de operaciones con conteos reales de artículos y existencias por sucursal.
- Catálogo paginado, edición auditada de fichas y control de cambios concurrentes.
- Historial de movimientos con búsqueda, paginación y exportación CSV de la página consultada.
- Creación y selección de sucursales desde la interfaz.
- Cotizador con documento imprimible, precios actualizados desde el servidor y atajo Ctrl+Enter.

**La vista previa es una simulación.** Usa tasa manual, no consulta el BCV, no registra ventas,
no confirma pagos ni emite facturas fiscales. La elegibilidad del IGTF es declarada en esta pantalla;
no constituye una determinación tributaria. Los precios del catálogo son USD **sin IVA**.
El servidor calcula importes monetarios con decimales y redondea cada base e impuesto a 2 decimales.
Esta política es provisional y debe armonizarse con el equipo fiscal antes de emitir documentos.

## Inicio local

Requisitos: Node.js 24, npm, Docker con daemon local disponible y puerto 55432 libre.
Usar el checkout existente; cada tarea en la nube ya está aislada y no requiere otro worktree.

```sh
cd /workspace/Sistema-de-Facturacion/backend
npm ci
npm run build
npm run db:local
npm run db:role
npm run migrate
npm run bootstrap:local

cd ../frontend
npm ci
npm run build

cd ../backend
npm start
```

El backend sirve la interfaz compilada en el puerto 3000 y la API bajo `/api`.
Las credenciales aleatorias del administrador local están en `backend/.local/admin.json`;
no se imprimen ni se versionan. La empresa y el RIF del bootstrap local son **ficticios**.

`db:local` crea credenciales aleatorias en `backend/.env`, un contenedor y un volumen persistente.
Preserva archivos existentes y no restablece contraseñas. El socket usado es el daemon local
`/var/run/docker.sock`; en otros sistemas se puede usar un PostgreSQL propio configurando `.env`.
No ejecutar `bootstrap:local` en producción. `db:role` crea `erp_app` una sola vez;
si el rol ya existe, su contraseña no cambia y debe coincidir con `DATABASE_URL`.

Para cambios en frontend: `npm run dev` en `frontend` (proxy de `/api` hacia el puerto 3000).
Para cambios de backend: recompilar con `npm run build`; `npm run start:dev` observa los archivos compilados.

## Pruebas

```sh
cd backend
npm test
npm run test:browser
```

Las pruebas requieren `TEST_ADMIN_DATABASE_URL` y `TEST_DATABASE_URL`, generadas por `db:local`.
Cada ejecución crea y elimina una **base de datos temporal**; no vacía la base de desarrollo.
El usuario de pruebas necesita permiso para crear bases. `erp_app` debe haberse creado antes.
La prueba de navegador requiere Chromium; usa `/usr/bin/chromium` o `CHROMIUM_PATH`.
También requiere dependencias instaladas en ambos directorios.

La suite verifica RLS, permisos, contexto del pool, autenticación, auditoría, reintentos,
competencia por la última unidad y cálculos decimales. El recorrido de navegador crea
un artículo, edita su ficha, ajusta su existencia, consulta movimientos, exporta CSV,
calcula pagos mixtos, comprueba la impresión y crea una sucursal en su base temporal.

## API inicial

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/health/live` | Disponibilidad del proceso |
| GET | `/api/health/ready` | Conexión y tablas migradas |
| POST | `/api/auth/login` | `{email, password}`; devuelve token y empresas |
| GET | `/api/auth/me` | Usuario y empresa seleccionada |
| DELETE | `/api/auth/session` | Revocar sesión |
| GET / POST | `/api/branches` | Consultar / crear sucursal |
| GET / POST | `/api/products` | Consultar / crear productos |
| PATCH | `/api/products/:id` | Editar ficha con `expectedVersion` y auditoría |
| GET | `/api/dashboard?branchId=...` | Conteos reales de catálogo y existencias |
| GET | `/api/inventory/stock?branchId=...` | Catálogo con existencias y paginación |
| GET | `/api/inventory/movements?branchId=...` | Movimientos auditados con paginación |
| GET | `/api/branches/:id/stock` | Existencias, máximo 500 filas |
| POST | `/api/inventory/adjustments` | Ajuste con UUID de idempotencia |
| POST | `/api/quotes/preview` | Simulación monetaria y fiscal |

Salvo login y salud, enviar `Authorization: Bearer <token>` y `X-Tenant-Id: <uuid>`.
El header selecciona una membresía ya validada; no concede acceso por sí solo.
Los decimales se envían como **texto con punto**, por ejemplo `"10.50"`.
La búsqueda de productos admite `search`, `limit` (máximo 100) y `offset`.

Ejemplo de ajuste:

```json
{
  "branchId": "UUID-DE-SUCURSAL",
  "productId": "UUID-DE-PRODUCTO",
  "delta": "10",
  "reason": "Conteo inicial de inventario",
  "idempotencyKey": "UUID-NUEVO-POR-OPERACION"
}
```

Reutilizar la misma clave y payload ante una respuesta incierta. Un payload diferente con
la misma clave se rechaza. El saldo y su movimiento se escriben en una sola transacción.

## Estructura

```text
backend/
  src/          API, autenticación, contexto RLS, inventario y cálculo decimal
  migrations/   Esquema, restricciones, políticas y privilegios
  scripts/      Migración, rol restringido y bootstrap
  test/         Pruebas unitarias, integración y navegador
frontend/
  src/          Catálogo, inventario y cotización
docs/           Arquitectura, límites y despliegue
```

Consulta [la arquitectura y siguientes módulos](docs/architecture.md) y
[la guía de Render](docs/render.md). Para ver cambios publicados en `main`, despliega el
último commit en Render; su estado operativo se verifica en el servicio remoto.

La migración `002_product_editing.sql` agrega la versión de las fichas y permisos de edición.
El arranque de Render la aplica antes de iniciar la API. Si arrancas mediante `npm start`
directamente, ejecuta primero `npm run migrate` con las credenciales administrativas.

La inspección de los adjuntos FoxPro se documenta en [archivos de referencia](docs/references/legacy-files.md).
