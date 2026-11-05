# Facturas desde imágenes y artículos del ejemplo

En **Facturas de compra → Importar imagen de factura**, un administrador puede subir
una fotografía JPEG, PNG o WebP (hasta 8 MB y 12 megapíxeles). El servidor valida los bytes,
normaliza la imagen y ejecuta Tesseract en español. No utiliza un servicio OCR externo
ni necesita una clave de IA. Solo se procesa una imagen a la vez por proceso; si hay otra
lectura devuelve 429. La lectura tiene un límite de 60 segundos, después de iniciar el motor.

La pantalla muestra la fotografía, proveedor, RIF, factura, control, fecha, cantidades,
costos, descuentos, IVA y total para revisión. Los campos que no se reconocen quedan
pendientes: el OCR puede omitir renglones, confundir caracteres o fallar con fotos torcidas.
La confianza mostrada es orientativa; no garantiza exactitud ni determina tratamiento fiscal.
Para esta primera versión, los importes de cada renglón se calculan como cantidad × costo,
menos descuento, más IVA. Otros recargos/retenciones no se interpretan automáticamente.
El total calculado debe coincidir con el declarado y el usuario debe confirmar su revisión.

Al guardar se crea **un borrador de compra** y sus maestros en una transacción:

- Proveedor identificado por RIF normalizado, sin sobrescribir datos del existente.
- Artículos reutilizados por código explícito o nombre completo único normalizado.
  No se agrupan medicamentos por similitud de marca, concentración o principio activo.
  Si hay varios nombres coincidentes, se exige seleccionar el código existente.
- Artículos nuevos con código interno, sin código de barras supuesto y **precio de venta
  pendiente**. Los costos de compra nunca se copian como precios de venta en USD.
- Documento con texto reconocido y SHA-256 de la imagen. El mismo archivo o número de
  factura del proveedor no se pueden importar de nuevo en la misma empresa.
- Ninguna existencia cambia hasta usar **Confirmar y recibir** en el documento guardado.
  La confirmación y los reintentos usan el control de inventario existente.

Los precios de venta pendientes impiden cotizar esos artículos, incluso llamando a la API.
La ficha permite corregir nombres e IVA manteniendo el precio pendiente en cero; indicar
un precio mayor que cero permite cotizar. Después de importar también se abre la pantalla
**Márgenes de ganancia**: permite fijar cada porcentaje sobre costo neto y añadir el IVA después.
La propuesta modifica los precios de artículos nuevos o existentes al confirmar la recepción,
según [el flujo de márgenes de compra](goods-documents.md#ganancia-e-iva-por-artículo).
Todas las operaciones requieren sesión y administrador; los registros mantienen el RLS.

El archivo original no se conserva en el disco efímero de Render ni en PostgreSQL. Solo
la vista actual permite cotejar la fotografía; el documento conserva su hash y texto OCR.
El archivo debe archivarse por separado. Un archivo recortado/recomprimido tendrá otro hash,
por lo que la restricción adicional por proveedor/número de factura sigue siendo necesaria.

## Ejemplo NICO PHARMA proporcionado

Se transcribieron 18 artículos con códigos internos `NP-EJ-001` a `NP-EJ-018`.
La presentación y marca BIOAIR deben cotejarse con el original. La transcripción es una
referencia manual, distinguida de una lectura OCR de la imagen que el usuario seleccione.

Los primeros 17 renglones suman **Bs 199.836,60**, igual al total impreso. El renglón
JERINGA DE INSULINA 1 ML (100 × Bs 35,45) agregaría **Bs 3.545,00**: con los 18, el total
sería Bs 203.381,60. La pantalla de ejemplo conserva la discrepancia y bloquea guardar
hasta que se revise; no descarta el artículo ni lo trata como bonificación automáticamente.
La tasa impresa Bs/USD 887,3 es referencia del documento, no una tasa BCV actual.
Como los costos y total están expresados en VES, la conversión a la moneda base VES es 1.

El arranque de desarrollo en Render carga el catálogo de 18 artículos en la empresa del
bootstrap, de forma idempotente, sin recibir stock ni registrar la factura discrepante.
Puede desactivarse con `SEED_NICOPHARMA_EXAMPLE=false`. La ventana también ofrece
**Crear artículos del ejemplo** para la empresa seleccionada. Los artículos que ya existen
con nombre completo coincidente conservan sus precios y datos; los códigos internos pueden
variar si se reutiliza un registro o si el código sugerido ya está ocupado.

Para cargar el catálogo en el desarrollo local, con migraciones aplicadas y bootstrap local:

```sh
cd backend
npm run build
npm run migrate
npm run seed:example
```

Ese helper rechaza servidores fuera de localhost y no imprime credenciales.

## Modelo OCR y despliegue

El modelo español de `tesseract-ocr/tessdata_fast`, bajo Apache-2.0, se incluye comprimido en
`resources/ocr`. `manifest.json` fija la revisión y hashes; el build de Render verifica su
integridad. El origen de cada archivo se comprobó contra el blob de esa revisión. No se
requiere descargar modelos al iniciar el servicio. `sharp` y Tesseract tienen soporte Node 24
Linux; el worker se termina al acabar cada lectura para liberar su memoria.

Se probó el OCR real con una imagen sintética legible, además del recorrido multipart en
Chromium y las transacciones en PostgreSQL. Esto no certifica exactitud sobre todas las fotos
ni reemplaza una revisión de los datos del proveedor.
