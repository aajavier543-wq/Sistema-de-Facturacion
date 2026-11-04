# Arquitectura inicial y siguientes módulos

## Límite de confianza

El navegador no accede directamente a PostgreSQL. La API valida una sesión opaca cuyo hash
SHA-256 se guarda en la base de datos, comprueba membresía y establece `app.tenant_id`
y `app.user_id` mediante `set_config(..., true)` dentro de cada transacción.
No se almacenan tokens en localStorage. Recargar la interfaz exige iniciar sesión otra vez.

El rol `erp_app` no es propietario ni tiene BYPASSRLS. La aplicación rechaza iniciar con
un rol privilegiado. Tablas de productos, sucursales, saldos, movimientos y auditoría
tienen RLS forzada; las relaciones compuestas impiden referencias cruzadas entre empresas.
Las sucursales y el inventario agregan políticas restrictivas de membresía.

Las tablas de identidad, sesiones y membresías son globales y están disponibles únicamente
para el backend confiable. El rol compartido puede consultarlas para autenticar; no deben
exponerse como acceso SQL a clientes. RLS no protege frente a un backend completamente
comprometido capaz de falsificar su contexto. Se requieren red privada, consultas parametrizadas
y credenciales diferenciadas. El rol de migración nunca se utiliza para atender HTTP.

El rol normal no puede modificar ni eliminar movimientos y auditorías. La base actual
representa stock simple por sucursal: aún no hay almacenes múltiples, reservas, lotes ni FEFO.
El libro de movimientos y el saldo se modifican de forma atómica; sus permisos de escritura
se limitan a los casos de uso del backend.

## Concurrencia

La actualización condicional de saldos evita negativos bajo concurrencia en READ COMMITTED.
Un bloqueo advisory por tenant y clave serializa reintentos de un mismo ajuste.
Una restricción única proporciona una segunda barrera de idempotencia. El registro de
auditoría se confirma junto con el movimiento. No se espera hardware ni bancos dentro
de una transacción SQL.

## Próximas entregas

1. **Venta persistida:** clientes, líneas inmutables con snapshots de impuestos/tasa,
   aplicaciones de pago, reservas y consumo de stock; outbox y estados independientes
   comercial, financiero y fiscal. Reintentos idempotentes y reversiones compensatorias.
2. **Política fiscal versionada y BCV:** tasas con fecha efectiva, evidencia de fuente,
   validación, antigüedad máxima y autorización de cargas manuales; reglas tributarias
   por condición, canal e instrumento. No basta con detectar USD.
3. **Caja:** apertura, turnos, movimientos por moneda/cuenta, conteo ciego y diferencias;
   obligaciones de vuelto y conciliación bancaria independiente del registro de caja.
4. **Agente fiscal:** elegir modelo/SDK homologado; cola local duradera, emisión serializada,
   consulta de resultado incierto, correlativo retornado por equipo y reportes X/Z.
5. **Compras/proveedores:** almacenamiento de originales, conectores SFTP/FTPS, staging,
   deduplicación y equivalencias; recepción física separada de factura; lotes y FEFO.
6. **Administración:** usuarios, recuperación de contraseña, MFA, listas de precios,
   CxC/CxP, contabilidad, reportes y supervisión operativa.

Antes de producción: validar política tributaria con especialistas y equipo fiscal,
completar recuperación de acceso/MFA, retención de sesiones e intentos de login,
límites por origen en la capa de ingreso, backups con restauración comprobada y métricas.
La limitación actual por cuenta puede ser usada para provocar bloqueos temporales;
requiere controles adicionales por origen y recuperación supervisada.

## Alcance de operación

La primera versión necesita conexión al servidor. No hay cobros bancarios integrados,
facturas, vueltos, ventas offline ni cierre fiscal. No se debe usar para facturar a clientes
reales. La cotización acepta una clasificación declarada y una tasa manual; la alícuota
de IGTF del simulador es 3 %, sin afirmar vigencia o aplicabilidad para una operación real.

La librería monetaria usa Decimal con precisión 40, no números binarios. La interfaz
convierte a Number solo para mostrar precios orientativos: la autoridad de cálculo es la API.
Se mantiene una excepción de dependencias documentada: override de Multer 2.5.0 para
evitar la versión 2.4.0 fijada por NestJS 11.2.8 (GHSA-q7qp-rjg7-q26m).
