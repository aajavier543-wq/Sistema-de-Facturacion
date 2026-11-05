# Ingreso y salida de mercancía

Implementación de ajustes y facturas de compra. El código se publica en `main` y su despliegue
debe verificarse en Render antes de afirmar que está disponible en la aplicación pública.
Las capturas de Profit se usan como referencia de flujo y campos.

## Ajustes de entrada y salida

1. Selecciona la empresa y sucursal.
2. Abre **Inventario → Ajustes de entrada y salida → Nuevo ajuste**.
3. Indica fecha, descripción y moneda. En bolívares la tasa es 1; en USD indica la tasa manual.
4. Busca artículos por código, código de barras o descripción. Cada renglón tiene tipo
   **Entrada** o **Salida**, cantidad positiva y costo unitario declarado.
5. **Guardar borrador** asigna un número interno `AJ-...` y conserva el documento sin mover stock.
6. **Confirmar ajuste** aplica todos los renglones en una sola transacción.

Se permiten entradas y salidas de artículos distintos en el mismo ajuste. Un artículo solo
puede aparecer una vez por documento. La salida resta existencias y el costo declarado neto
del ajuste se presenta con signo. Si un renglón no tiene disponibilidad, no se aplica ninguno.

Desde **Artículos y existencias → Ajustar existencia** se abre esta misma pantalla con el
artículo seleccionado. No hay una segunda pantalla de ajuste rápido dentro de la interfaz.

## Facturas de compra

1. Abre **Compras → Facturas de compra → Nueva factura de compra**.
2. Selecciona un proveedor o regístralo con RIF y razón social.
3. Introduce fecha, descripción, número de factura del proveedor, número de control,
   condición de pago, moneda y tasa. Para crédito, indica un vencimiento no anterior a la factura.
4. Agrega cantidades, costos unitarios, descuento porcentual e IVA por renglón (0/exento, 8 o 16 %).
5. Guarda y revisa el borrador. **Confirmar y recibir** registra la recepción y las entradas de stock.

El número `FC-...` es un identificador interno; no sustituye el número/control del proveedor
ni es un correlativo fiscal de ventas. El sistema rechaza un segundo documento con el mismo
número de factura normalizado para el mismo proveedor y empresa, incluso en otra sucursal.

La condición de pago es informativa: esta entrega no ejecuta pagos, no mueve caja/bancos y
no lleva aún cuentas por pagar. Una compra recibida no modifica el precio de venta del artículo.

## Consulta, permisos y protección

- **Lista** permite buscar documentos y abrir borradores o confirmados.
- Los borradores pueden editarse con control de versión. Los confirmados no pueden editarse
  ni eliminarse, ni sus renglones; existen protecciones también en PostgreSQL.
- La creación usa una clave UUID de idempotencia. Repetir el mismo payload devuelve el mismo
  documento; cambiar el payload con esa clave genera conflicto.
- Confirmar un documento ya confirmado devuelve su estado sin repetir movimientos.
- Los movimientos guardan documento y renglón de origen y se consultan en el historial.
- Se requieren permisos de administrador. RLS aplica aislamiento por empresa y sucursal en
  documentos y renglones, y por empresa en proveedores y contadores.
- Los números internos se asignan mediante contadores transaccionales, no con `MAX + 1`.
- El bloqueo de existencias sigue el orden de los artículos para reducir interbloqueos.

Atajos: **F2** busca artículos; **Ctrl+S** guarda el borrador. Los cambios de formulario se
conservan al navegar a otro módulo dentro de la sesión; antes de cambiar empresa/sucursal
o cerrar sesión se solicita descartar los cambios que no se guardaron.

## Costos y redondeo

Se utiliza Decimal con precisión 40. Por renglón se redondean bruto, descuento e IVA a dos
decimales mediante HALF_UP. Los totales son la suma de esos importes, con signo para ajustes.
Los importes de moneda se envían a la API como texto, sin separadores de miles.

La recepción convierte el costo neto sin IVA a bolívares mediante la tasa del documento.
El promedio de existencias con costo conocido se actualiza ponderando cantidad y costo.
Las salidas usan ese promedio en su valoración y no lo reemplazan por el costo declarado.
Los costos aplicados quedan guardados en los renglones y movimientos al confirmar.

Las existencias históricas no tenían costo en la versión anterior: la migración deja su
promedio en NULL. Una entrada no reconstruye un costo histórico inexistente. Si hay cantidad
previa con costo desconocido, el promedio permanece desconocido; cuando el stock está en cero,
una nueva entrada establece un costo conocido. El endpoint antiguo de ajustes sin costo
invalida el promedio al ingresar mercancía, en vez de producir una valoración falsa.

La fecha del documento es informativa para su registro. Las confirmaciones operan sobre el
stock y promedio actuales; no recalculan retroactivamente movimientos históricos.

## Alcance de ubicación y unidades

Esta entrega usa la sucursal como ubicación de inventario y UNI como unidad base.
No hay todavía almacenes internos, lotes, vencimientos de mercancía ni conversión de
cajas/blísteres/unidades. La fecha de vencimiento capturada es la del crédito de la factura.
No se agregó importación FTP, emisión fiscal, anulaciones ni devolución de compras.

## API

| Método | Ruta | Uso |
|---|---|---|
| GET / POST | `/api/goods/suppliers` | Buscar o registrar proveedores |
| GET | `/api/goods/documents?kind=adjustment&branchId=...` | Lista paginada; también admite `kind=purchase` |
| GET | `/api/goods/documents/:id` | Encabezado y renglones |
| POST | `/api/goods/documents/preview` | Validar referencias y calcular, sin guardar |
| POST | `/api/goods/documents` | Crear borrador con `idempotencyKey` |
| PATCH | `/api/goods/documents/:id` | Reemplazar el borrador con `expectedVersion` |
| POST | `/api/goods/documents/:id/confirm` | Confirmar con `{ "expectedVersion": 0 }` |

La migración `003_goods_documents.sql` agrega estas tablas, referencias, permisos, costos
y protecciones. Antes de iniciar la API local hay que ejecutar `npm run build` y
`npm run migrate` desde `backend`; el script de Render ya ejecuta las migraciones al arrancar,
pero su configuración y sus recursos no fueron modificados en esta tarea.

Las pruebas usan bases temporales y cubren borradores, idempotencia, costos, IVA, duplicados,
salidas concurrentes, rollback integral, inmovilidad de confirmados, RLS y ambos recorridos
de interfaz. Los datos de esas pruebas no se cargan en la empresa de desarrollo.
