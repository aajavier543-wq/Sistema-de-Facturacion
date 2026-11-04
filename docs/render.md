# Despliegue inicial en Render

Esta guía prepara un despliegue; no crea servicios ni publica automáticamente.

## Despliegue de desarrollo con Blueprint

El archivo raíz `render.yaml` define una API + interfaz gratuita en Oregon y referencia
la instancia PostgreSQL existente `farma-educa-db` de ese mismo workspace. No intenta crear
una segunda instancia gratuita ni modificar los servicios `farma-educa` y `domino-club`.
Revisa los límites de capacidad, caducidad y suspensión del plan gratuito en Render.

El arranque crea una **base lógica separada** `nexo_facturacion` dentro de esa instancia,
mediante `APP_DATABASE_NAME`. Las tablas de la aplicación original se conservan en su base
actual. Ambas bases comparten recursos y disponibilidad de la instancia; no son instancias
independientes. Se requiere PostgreSQL 16 o superior y permiso CREATEDB del propietario.
Render documenta esta modalidad en:
https://render.com/docs/postgresql-creating-connecting#adding-multiple-databases-to-a-single-instance

Si la base destino ya existe con datos no reconocidos, la inicialización se detiene antes
de ejecutar migraciones. No se eliminan tablas ni bases ni se restablecen contraseñas.
Para usar otra instancia, cambia el nombre de `fromDatabase` y verifica la región del servicio.

Con el código publicado en `main`, abre:

https://render.com/deploy?repo=https://github.com/aajavier543-wq/Sistema-de-Facturacion

Autoriza el repositorio si Render lo solicita. Durante la creación configura `BOOTSTRAP_EMAIL`
y `BOOTSTRAP_PASSWORD` (mínimo 12 caracteres) de forma privada. Son el acceso inicial a la
aplicación. La empresa y RIF del Blueprint son ficticios, solo para desarrollo.

El build usa `scripts/render-build.sh`. El arranque usa `backend/dist/scripts/start-render.js`:

1. Crea o selecciona `nexo_facturacion` en la instancia existente sin migrar la base original.
2. Crea el rol restringido `erp_app` si no existe, aplica migraciones en la base separada y
   comprueba el acceso del rol restringido. No cambia contraseñas existentes.
3. Crea empresa, sucursal y administrador si no existen. Los reinicios no duplican registros
   ni restablecen contraseñas. Cambiar una variable de bootstrap no modifica una cuenta existente.
4. Inicia el proceso HTTP hijo con `DATABASE_URL` del rol restringido y elimina de su entorno
   las credenciales del propietario, bootstrap y API de Render.

La inicialización requiere que el propietario suministrado por Render pueda crear bases y roles.
Si no puede, el despliegue falla explícitamente en vez de servir HTTP como propietario.
Los secretos de inicialización permanecen en la configuración del servicio y en el proceso
supervisor; el proceso que atiende HTTP no los hereda. Esta es una configuración de demostración.
Para producción, usa el flujo de tarea de migración separada descrito debajo.

Una vez que Render asigne la URL, comprobar `/api/health/ready`, iniciar sesión, crear un
producto, ajustar existencias y calcular una cotización. Un build exitoso no confirma por sí
solo que el servicio remoto funciona. El Blueprint mantiene el autodespliegue desactivado;
los siguientes cambios requieren un despliegue manual.

Si el Blueprint ya falló por el límite de una base gratuita, abre su pantalla **Syncs** y pulsa
**Manual sync** después de publicar esta corrección en `main`. La referencia `fromDatabase`
puede apuntar a una instancia existente fuera del Blueprint; no es necesario borrar la base
gratuita para volver a intentarlo. Asegúrate de conservar el email y contraseña de bootstrap
que elegiste al crear el Blueprint; Render ignora nuevas variables `sync: false` al actualizar
un Blueprint existente.

### Diagnóstico de arranque

Los registros muestran la etapa activa con `[deployment]`:
`configuration`, `select_database`, `inspect_database`, `provision_role`, `migrations`,
`runtime_connection` y `bootstrap`. Ante un fallo se imprime únicamente etapa, código,
nombres de variables inválidas y una indicación estática; nunca URLs, contraseñas, SQL,
mensajes completos de PostgreSQL ni stacks que puedan contenerlos.

- `INVALID_CONFIGURATION`: en **Environment** corrige las variables listadas en `fields`.
  En particular, `BOOTSTRAP_EMAIL` debe ser un correo válido y `BOOTSTRAP_PASSWORD` debe
  tener 12–128 caracteres. El Blueprint no rellena automáticamente estos secretos al
  actualizar una configuración existente después de una sincronización fallida.
- `42501` en `select_database`: el propietario no tiene permiso para crear la base lógica.
- `42501` en `provision_role`: el propietario no tiene permiso para crear `erp_app`.
- `28P01` en `runtime_connection`: el rol ya existe y su contraseña no coincide con
  `APP_DB_PASSWORD`. El programa conserva las credenciales existentes.

Después de corregir valores en **Environment**, guarda y despliega de nuevo. No publiques
los valores ni la URL de conexión al compartir los registros. La etapa y código bastan para
continuar el diagnóstico. El build exitoso no identifica un fallo de inicialización.

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
