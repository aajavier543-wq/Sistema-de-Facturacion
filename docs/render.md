# Despliegue inicial en Render

Esta guía prepara un despliegue; no crea servicios ni publica automáticamente.

## Despliegue de desarrollo con Blueprint

El archivo raíz `render.yaml` define una API + interfaz y PostgreSQL 17 en la misma región.
Solicita planes gratuitos; revisa su disponibilidad, caducidad, suspensión y límites actuales
en Render antes de crear recursos. No se selecciona automáticamente un plan de pago.

Con el código publicado en `main`, abre:

https://render.com/deploy?repo=https://github.com/aajavier543-wq/Sistema-de-Facturacion

Autoriza el repositorio si Render lo solicita. Durante la creación configura `BOOTSTRAP_EMAIL`
y `BOOTSTRAP_PASSWORD` (mínimo 12 caracteres) de forma privada. Son el acceso inicial a la
aplicación. La empresa y RIF del Blueprint son ficticios, solo para desarrollo.

El build usa `scripts/render-build.sh`. El arranque usa `backend/dist/scripts/start-render.js`:

1. Crea el rol restringido `erp_app` si no existe, sin cambiar contraseñas existentes.
2. Aplica migraciones una vez y comprueba el acceso del rol restringido.
3. Crea empresa, sucursal y administrador si no existen. Los reinicios no duplican registros
   ni restablecen contraseñas. Cambiar una variable de bootstrap no modifica una cuenta existente.
4. Inicia el proceso HTTP hijo con `DATABASE_URL` del rol restringido y elimina de su entorno
   las credenciales del propietario, bootstrap y API de Render.

La inicialización requiere que el propietario suministrado por Render pueda crear roles.
Si no puede, el despliegue falla explícitamente en vez de servir HTTP como propietario.
Los secretos de inicialización permanecen en la configuración del servicio y en el proceso
supervisor; el proceso que atiende HTTP no los hereda. Esta es una configuración de demostración.
Para producción, usa el flujo de tarea de migración separada descrito debajo.

Una vez que Render asigne la URL, comprobar `/api/health/ready`, iniciar sesión, crear un
producto, ajustar existencias y calcular una cotización. Un build exitoso no confirma por sí
solo que el servicio remoto funciona. El Blueprint mantiene el autodespliegue desactivado;
los siguientes cambios requieren un despliegue manual.

## Operación con tareas administrativas separadas

1. Crear PostgreSQL y un Web Service Node.js en la misma región.
2. Instalar y compilar desde la raíz con:

   ```sh
   npm ci --prefix backend --include=dev
   npm ci --prefix frontend --include=dev
   npm run build --prefix backend
   npm run build --prefix frontend
   ```

3. Usar `npm start --prefix backend` como comando de inicio y
   `/api/health/ready` como health check. La API sirve también el frontend; no requiere CORS.
   Configurar Node.js 24 mediante `NODE_VERSION` en el servicio.
4. Con las credenciales de propietario, crear el rol `erp_app` ejecutando
   `npm run db:role --prefix backend` desde una sesión de administración confiable.
   Requiere `MIGRATION_DATABASE_URL` y una `APP_DB_PASSWORD` de al menos 16 caracteres.
   Si el usuario suministrado no tiene CREATEROLE, resolverlo con la administración del
   PostgreSQL contratado; no atender HTTP con el propietario como alternativa.
5. Ejecutar `npm run migrate --prefix backend` con `MIGRATION_DATABASE_URL`.
   Las migraciones están serializadas y cada archivo se aplica una sola vez.
6. Registrar una empresa real con `npm run bootstrap --prefix backend`, suministrando
   `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` (12–128 caracteres), `BOOTSTRAP_COMPANY` y
   `BOOTSTRAP_RIF` por una vía segura. No hay contraseña predeterminada.
7. Configurar en el servicio normal únicamente `DATABASE_URL` para **erp_app** y `PORT`
   suministrado por Render. No conservar en ese proceso contraseñas de propietario,
   `APP_DB_PASSWORD` ni variables de bootstrap.

Usar la conexión interna suministrada por Render. Para conexiones externas que requieran
TLS, utilizar la configuración y CA del proveedor; no desactivar verificación de certificados.
No copiar una URL de propietario al runtime. No hay deploy automático desde este repositorio.

Para migraciones futuras utilizar una tarea controlada separada con el secreto de propietario.
No ejecutar migraciones con credenciales privilegiadas dentro del proceso HTTP.
Este primer despliegue sigue siendo de desarrollo: faltan los módulos fiscales y de venta.
